import os
from django.http import JsonResponse
from demo_site.catalog import CATALOG

# Created when the URLconf first imports this module, in each worker.
ROUTE_TABLE = {f"/route/{i}": {"name": f"route-{i}", "weight": i} for i in range(20_000)}


def ping(request):
    return JsonResponse({"pid": os.getpid()})


def scan(request):
    total = 0
    for item in CATALOG:
        total += item["price"]
    return JsonResponse({"pid": os.getpid(), "total": total})
