import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "demo_site.settings")
from demo_site import catalog  # noqa: F401
from django.core.wsgi import get_wsgi_application
application = get_wsgi_application()
