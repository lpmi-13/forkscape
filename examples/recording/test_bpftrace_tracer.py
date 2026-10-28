"""Tests for the conversion of bpftrace records into Forkscape events. No root or bpftrace needed:

    python3 -m unittest discover -s examples/recording
"""

import unittest

import bpftrace_tracer as record

ROOT, CHILD = 100, 101
MARKERS = "/tmp/forkscape-trace-x/markers.ndjson"


def lines(*records: str) -> list[str]:
    return [record.replace(" ", "\t") + "\n" for record in records]


def convert(*records: str, **options):
    events, names, counts = record.convert(lines(*records), ROOT, MARKERS, **options)
    return events, names, counts


def named(events, name):
    return [event for event in events if event["name"] == name]


EXEC = ("B 1000 100", "M 1100 100 400000 8192 75 0 2049 77 python3", "K 1150 100 401000 2",
        "P 1050 2049 77 /usr/bin/python3", "X 1200 100 99 7ffd00001000 7ffd00001fe0 1a00000 7ffd10000000 python3")


class ExecTests(unittest.TestCase):
    def test_exec_comes_first_and_the_kernel_mappings_follow_it(self):
        events, names, _ = convert("U 900 100 1234 6", *EXEC)
        self.assertEqual([event["name"] for event in events[:4]], ["exec", "mmap", "mmap", "mmap"])
        self.assertEqual(events[0]["ts"], 1.0, "exec takes the time execve began")
        self.assertEqual(events[0]["args"], {"comm": "python3", "ppid": 99})
        stack = events[1]["args"]
        self.assertEqual(stack["name"], "[stack]")
        self.assertEqual(int(stack["addr"], 16) + stack["len"], 0x7ffd00002000 + 2 * 4096, "the stack ends two pages above env_end")
        self.assertEqual([event["args"].get("name") for event in events[2:4]], ["[vvar]", "[vdso]"])
        program = events[4]
        self.assertEqual(program["args"], {"addr": "0x400000", "len": 8192, "perms": "r-xp", "file": "/usr/bin/python3", "offset": 0})
        self.assertGreaterEqual(program["ts"], events[0]["ts"])
        self.assertEqual(named(events, "fault")[0]["args"], {"addr": "0x401000", "write": True, "kernel": True})
        self.assertEqual(len(named(events, "fault")), 1, "a fault before the root's exec is not recorded")
        self.assertEqual(names, {ROOT: "python3"})

    def test_a_failed_exec_drops_what_it_buffered(self):
        events, _, _ = convert("B 500 100", "BF 510 100 -2", "U 520 100 5000 6", *EXEC)
        self.assertEqual(len(named(events, "exec")), 1)
        self.assertEqual(len(named(events, "fault")), 1)


class ProcessTests(unittest.TestCase):
    def test_fork_copies_descriptors_and_a_reused_pointer_after_close_is_a_new_object(self):
        events, names, counts = convert(*EXEC, "I 1300 100 3 ffff1 2049 900 8000 log.txt", "P 1290 2049 900 /var/log/log.txt",
                                        "F 1400 100 100 101 1200011", "C 1500 101 3", "C 1510 100 3",
                                        "I 1600 100 4 ffff1 2049 901 8000 other.txt", "E 1700 101 0", "R 1710 100 101", "R 1800 1 100")
        opens = named(events, "open")
        self.assertEqual(opens[0]["args"], {"fd": 3, "object": "file#1", "kind": "file", "name": "/var/log/log.txt"})
        self.assertEqual(opens[1]["args"]["object"], "file#2", "a struct file pointer reused after its last close is a new object")
        self.assertEqual([(event["pid"], event["args"]["fd"]) for event in named(events, "close")], [(CHILD, 3), (ROOT, 3)])
        self.assertEqual(named(events, "fork")[0]["args"], {"child": CHILD})
        self.assertEqual(named(events, "reap")[0]["args"], {"child": CHILD}, "the root's own reap is not recorded")
        self.assertEqual(len(named(events, "reap")), 1)
        self.assertEqual(names[CHILD], "python3")
        self.assertEqual(counts["fork"], 1)

    def test_vfork_threads_and_the_oom_killer(self):
        events, _, _ = convert(*EXEC, "F 1300 100 100 101 4111", "T 1310 100 100 102", "O 1400 101", "E 1410 101 9")
        self.assertEqual(named(events, "fork")[0]["args"], {"child": CHILD, "vfork": True})
        self.assertEqual(named(events, "thread")[0]["args"], {"new_tid": 102})
        self.assertEqual(named(events, "oom_kill")[0]["pid"], CHILD)

    def test_processes_outside_the_tree_are_left_out(self):
        events, _, _ = convert(*EXEC, "U 1300 555 1000 6", "F 1310 555 555 556 1200011", "M 1320 556 7f0000000000 4096 73 0 0 0 0 ")
        self.assertEqual({event["pid"] for event in events}, {ROOT})


class MemoryTests(unittest.TestCase):
    def test_fault_around_leaves_out_the_faulting_page(self):
        events, _, counts = convert(*EXEC, "U 1300 100 7f0000003010 4", "A 1301 100 7f0000002000 1 7f0000003000",
                                    "A 1302 100 7f0000003000 1 7f0000003000", "A 1303 100 7f0000004000 2 7f0000003000")
        around = [event["args"]["addr"] for event in named(events, "fault") if event["args"].get("around")]
        self.assertEqual(around, ["0x7f0000002000", "0x7f0000004000", "0x7f0000005000"])
        self.assertEqual(counts["around"], 3)

    def test_brk_bss_mremap_madvise_and_shared_mappings(self):
        events, _, _ = convert("B 1000 100", "H 1100 100 600000 4096", *EXEC[1:], "H 1300 100 1a00000 135168",
                               "HB 1301 100 1a00000 1a21000", "HB 1400 100 1a21000 1a10010", "Q 1500 100 7f0000000000 8192 16384 7f0000100000",
                               "V 1600 100 7f0000100000 4096 4", "M 1700 100 7f0000200000 4096 f9 0 2049 78 shm")
        maps = named(events, "mmap")
        self.assertEqual(next(event["args"]["name"] for event in maps if event["args"]["addr"] == "0x600000"), "bss", "brk during exec is the bss")
        heap = [event["args"] for event in maps if event["args"].get("name") == "[heap]"]
        self.assertEqual(heap, [{"addr": "0x1a00000", "len": 135168, "name": "[heap]", "perms": "rw-p"}], "growth comes from do_brk_flags, not the brk call")
        self.assertEqual(named(events, "munmap")[0]["args"], {"addr": "0x1a11000", "len": 0x10000})
        self.assertEqual(named(events, "mremap")[0]["args"], {"addr": "0x7f0000000000", "old_len": 8192, "new_len": 16384, "new_addr": "0x7f0000100000"})
        self.assertEqual(named(events, "madvise")[0]["args"]["advice"], "dontneed")
        self.assertEqual(maps[-1]["args"]["perms"], "r--s", "VM_MAYSHARE marks a shared mapping")

    def test_brk_growth_comes_from_the_brk_call_when_do_brk_flags_cannot_be_traced(self):
        events, _, _ = convert(*EXEC, "HB 1301 100 1a00000 1a21000", brk_growth=True)
        self.assertEqual([event["args"] for event in named(events, "mmap") if event["args"].get("name") == "[heap]"],
                         [{"addr": "0x1a00000", "len": 0x21000, "name": "[heap]", "perms": "rw-p"}])


class DescriptorTests(unittest.TestCase):
    def test_sockets_take_the_port_they_listen_on_and_the_markers_file_is_hidden(self):
        events, _, _ = convert(*EXEC, "I 1300 100 5 aa 8 4000 c000 socket 2 7 0", "L 1310 100 aa 8017",
                               "I 1400 100 6 bb 8 4001 c000 socket 2 1 8017", "I 1500 100 7 cc 2049 50 8000 markers.ndjson",
                               f"P 1490 2049 50 {MARKERS}", "C 1600 100 7", "I 1700 100 8 dd 9 60 1000 pipe", "D 1800 100 8 9")
        opens = [event["args"] for event in named(events, "open")]
        self.assertEqual([item["name"] for item in opens], ["listening socket :8017", "connection on :8017", "pipe:[60]", "pipe:[60]"])
        self.assertEqual([item["fd"] for item in opens], [5, 6, 8, 9])
        self.assertEqual(opens[2]["object"], opens[3]["object"], "dup2 gives the new descriptor the same object")
        self.assertEqual(named(events, "close"), [], "the markers file's close is hidden with it")


class NamespaceTests(unittest.TestCase):
    def test_host_pids_become_the_containers_own(self):
        raw = lines("B 1000 2028", "X 1200 2028 1990 7ffd00001000 7ffd00001fe0 1a00000 7ffd10000000 python", "NS 1201 2028 1",
                    "F 1300 2028 2028 2080 1200011", "NS 1301 2080 7", "T 1400 2080 2080 2090", "NS 1401 2090 9", "R 1500 2028 2080")
        events, names, _ = record.convert(raw, 2028, MARKERS)
        events, names = record.translate(events, names, record.namespace_pids(raw))
        self.assertEqual(events[0]["name"], "exec")
        self.assertEqual(events[0]["args"]["ppid"], 0, "the container runtime is not in the container's namespace")
        fork = named(events, "fork")[0]
        self.assertEqual((fork["pid"], fork["args"]["child"]), (1, 7))
        thread = named(events, "thread")[0]
        self.assertEqual((thread["pid"], thread["args"]["new_tid"]), (7, 9))
        self.assertEqual(named(events, "reap")[0]["args"]["child"], 7)
        self.assertEqual(set(names), {1, 7})

    def test_host_recordings_keep_their_pids(self):
        raw = lines(*EXEC, "NS 1201 100 100")
        events, names, _ = record.convert(raw, ROOT, MARKERS)
        translated, _ = record.translate(events, names, record.namespace_pids(raw))
        self.assertEqual({event["pid"] for event in translated}, {ROOT})


if __name__ == "__main__":
    unittest.main()
