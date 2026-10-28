"""Tests for the pagemap sampler's inference from snapshots to events. No workload or /proc needed:

    python3 -m unittest discover -s examples/recording
"""

import unittest

from pagemap_sampler import EXCLUSIVE, FILE_PAGE, PAGE, PRESENT, Area, Inference, Seen

ENTRY = {"A": 0, "X": PRESENT | EXCLUSIVE, "S": PRESENT, "C": PRESENT | FILE_PAGE}
HEAP = 0x1000  # in pages
LIB = 0x7000


def area(first: int, states: str, perms: str = "rw-p", path: str = "", inode: int = 0, offset: int = 0):
    """An area of len(states) pages from page `first`, and its pagemap: A absent, X exclusive, S shared, C page cache."""
    mapped = Area(first * PAGE, (first + len(states)) * PAGE, perms, offset, "fd:01" if inode else "00:00", inode, path)
    return mapped, b"".join(ENTRY[state].to_bytes(8, "little") for state in states)


def seen(pid: int, *areas, ppid: int = 1, at: float = 0, start: int = 10, minflt: int = 0, image=(1, 2, 3), fds=None) -> Seen:
    return Seen(pid, ppid, start, "python", minflt, image, at, [item[0] for item in areas],
                {(item[0].start, item[0].end): item[1] for item in areas}, fds=dict(fds or {}), tids={pid})


def names(events, *wanted):
    return [event for event in events if event["name"] in wanted]


def address(page: int) -> str:
    return f"0x{page * PAGE:x}"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.model = Inference()
        self.model.exec(100, 0, "python")

    def step(self, *processes, exited=(), gone=(), sync=None, at=None):
        start = len(self.model.events)
        latest = max([process.at for process in processes] or [0])
        self.model.step({process.pid: process for process in processes}, set(exited), set(gone), sync or {}, at=at or latest)
        return self.model.events[start:]


class FirstSnapshotTests(Fixture):
    def test_mappings_come_before_their_faults(self):
        events = self.step(seen(100, area(HEAP, "XXA", path="[heap]"), area(LIB, "CCA", "r-xp", "/usr/lib/libc.so.6", 77), area(0x2000, "S"), at=1000))
        self.assertEqual([event["name"] for event in events[:3]], ["mmap", "mmap", "mmap"])
        self.assertEqual(events[0]["args"], {"addr": address(HEAP), "len": 3 * PAGE, "perms": "rw-p", "name": "[heap]"})
        self.assertEqual(events[1]["args"]["file"], "/usr/lib/libc.so.6")
        faults = names(events, "fault")
        self.assertEqual([(fault["args"]["addr"], fault["args"]["write"]) for fault in faults],
                         [(address(HEAP), True), (address(HEAP + 1), True), (address(LIB), False), (address(LIB + 1), False), (address(0x2000), False)],
                         "anonymous pages are writes, file pages and the zero page are reads")

    def test_a_relocated_read_only_range_is_mapped_writable(self):
        events = self.step(seen(100, area(LIB, "XC", "r--p", "/usr/lib/libc.so.6", 77), at=1000))
        self.assertEqual(names(events, "mmap")[0]["args"]["perms"], "rw-p", "its copies were made before mprotect")


class ChangeTests(Fixture):
    def test_unchanged_memory_gives_no_events(self):
        self.step(seen(100, area(HEAP, "XXA"), at=1000))
        self.assertEqual(self.step(seen(100, area(HEAP, "XXA"), at=2000)), [])

    def test_a_vanished_page_is_dropped_and_growth_is_mapped(self):
        self.step(seen(100, area(HEAP, "XXX", path="[heap]"), at=1000))
        events = self.step(seen(100, area(HEAP, "XAXX", path="[heap]"), at=2000))
        self.assertEqual([event["name"] for event in events], ["mmap", "fault", "madvise"])
        self.assertEqual(events[0]["args"]["addr"], address(HEAP + 3))
        self.assertEqual(events[2]["args"], {"addr": address(HEAP + 1), "len": PAGE, "advice": "dontneed"})

    def test_a_permission_change_is_not_a_new_mapping(self):
        self.step(seen(100, area(HEAP, "XX"), at=1000))
        split = (Area(HEAP * PAGE, (HEAP + 1) * PAGE, "r--p", 0, "00:00", 0, ""), (ENTRY["X"]).to_bytes(8, "little"))
        rest = (Area((HEAP + 1) * PAGE, (HEAP + 2) * PAGE, "rw-p", 0, "00:00", 0, ""), (ENTRY["X"]).to_bytes(8, "little"))
        self.assertEqual(self.step(seen(100, split, rest, at=2000)), [])

    def test_markers_place_changes_just_before_them(self):
        self.step(seen(100, area(HEAP, "XA"), at=1000))
        events = self.step(seen(100, area(HEAP, "XX"), at=2000), sync={100: 1500})
        self.assertEqual(events[0]["ts"], 1499)


class ForkTests(Fixture):
    def test_a_fork_shares_pages_and_a_copy_goes_to_the_process_that_faulted(self):
        self.step(seen(100, area(HEAP, "XXXX"), at=1000))
        events = self.step(seen(100, area(HEAP, "SSSS"), at=2000), seen(101, area(HEAP, "SSSS"), ppid=100, at=2001, start=150))
        self.assertEqual([event["name"] for event in events], ["fork"], "the child shares every page, so nothing else happened")
        events = self.step(seen(100, area(HEAP, "XSSS"), at=3000, minflt=0), seen(101, area(HEAP, "XSSS"), ppid=100, at=3001, minflt=5, start=150))
        self.assertEqual([(event["pid"], event["name"], event["args"]["addr"]) for event in events], [(101, "fault", address(HEAP))])
        self.assertEqual(self.step(seen(100, area(HEAP, "XSSS"), at=4000), seen(101, area(HEAP, "XSSS"), ppid=100, at=4001, start=150)), [])

    def test_with_three_sharers_the_one_exclusive_page_is_the_copy(self):
        self.step(seen(100, area(HEAP, "XX"), at=1000))
        self.step(seen(100, area(HEAP, "SS"), at=2000), seen(101, area(HEAP, "SS"), ppid=100, at=2001, start=150),
                  seen(102, area(HEAP, "SS"), ppid=100, at=2002, start=151))
        events = self.step(seen(100, area(HEAP, "SS"), at=3000, minflt=50), seen(101, area(HEAP, "XS"), ppid=100, at=3001, start=150),
                           seen(102, area(HEAP, "SS"), ppid=100, at=3002, start=151))
        self.assertEqual([(event["pid"], event["args"]["addr"]) for event in names(events, "fault")], [(101, address(HEAP))])

    def test_what_the_parent_wrote_before_the_fork_comes_before_it(self):
        self.step(seen(100, area(HEAP, "XA"), at=1000))
        events = self.step(seen(100, area(HEAP, "SS"), at=2000), seen(101, area(HEAP, "SS"), ppid=100, at=2001, start=150))
        self.assertEqual([(event["pid"], event["name"]) for event in events], [(100, "fault"), (100, "fork")])
        self.assertLess(events[0]["ts"], events[1]["ts"])

    def test_the_parents_own_changes_come_after_the_fork(self):
        self.step(seen(100, area(HEAP, "XA"), at=1000))
        events = self.step(seen(100, area(HEAP, "SX"), at=2000), seen(101, area(HEAP, "SA"), ppid=100, at=2500, start=250), at=2000)
        fork, fault = names(events, "fork")[0], names(events, "fault")[0]
        self.assertEqual(fault["pid"], 100)
        self.assertGreater(fault["ts"], fork["ts"])

    def test_a_child_that_already_execd_starts_afresh(self):
        self.step(seen(100, area(LIB, "C", "r-xp", "/usr/bin/python3", 5), at=1000))
        events = self.step(seen(100, area(LIB, "C", "r-xp", "/usr/bin/python3", 5), at=2000),
                           seen(101, area(LIB, "C", "r-xp", "/bin/sh", 9), ppid=100, at=2001, start=150))
        self.assertEqual([event["name"] for event in events], ["fork", "exec", "mmap", "fault"])

    def test_inherited_descriptors_are_not_opened_again(self):
        socket = "socket:[555]"
        self.step(seen(100, area(HEAP, "X"), at=1000, fds={3: socket}))
        events = self.step(seen(100, area(HEAP, "S"), at=2000, fds={3: socket}),
                           seen(101, area(HEAP, "S"), ppid=100, at=2001, start=150, fds={3: socket, 4: "socket:[600]"}))
        opens = names(events, "open")
        self.assertEqual([(event["pid"], event["args"]["fd"]) for event in opens], [(101, 4)])

    def test_exit_then_reap(self):
        self.step(seen(100, area(HEAP, "X"), at=1000))
        self.step(seen(100, area(HEAP, "S"), at=2000), seen(101, area(HEAP, "S"), ppid=100, at=2001, start=150))
        events = self.step(seen(100, area(HEAP, "X"), at=3000), exited={101}, at=3000)
        self.assertEqual([event["name"] for event in events], ["exit"])
        events = self.step(seen(100, area(HEAP, "X"), at=4000), gone={101}, at=4000)
        self.assertEqual([(event["name"], event["pid"], event["args"]) for event in events], [("reap", 100, {"child": 101})])


if __name__ == "__main__":
    unittest.main()
