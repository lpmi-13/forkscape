# Built at import time, like a lookup table loaded by a preloaded app. With preload_app, the master builds it before it
# forks, so the workers share its pages until they write to them; reading an entry writes its reference count.
CATALOG = [{"id": 1000 + i, "name": f"item-{i}", "price": 3 * i + 1000} for i in range(150_000)]
