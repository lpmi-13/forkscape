from django.urls import path
from demo_site import views
urlpatterns = [path("ping", views.ping), path("scan", views.scan)]
