# The demo workload as a container image, for record_container_bpftrace.py and record_container_sampler.py:
#   docker build -t forkscape-demo examples/recording
# The image runs as an unprivileged user and needs no capabilities. To record your own image with the sampler, copy the
# three forkscape files and sampled_entrypoint.py into it, as here, and put sampled_entrypoint.py before your command.
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir "django==6.1.*" "gunicorn==26.*"
COPY demo_app/ /app/
COPY forkscape_markers.py pagemap_sampler.py recording_file.py sampled_entrypoint.py /opt/forkscape/
ENV PYTHONPATH=/opt/forkscape PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
USER 1001:1001
EXPOSE 8017
CMD ["python", "-m", "gunicorn", "demo_site.wsgi:application", "-c", "gunicorn_conf.py", "--workers", "2", "--bind", "0.0.0.0:8017", "--log-level", "warning", "--preload"]
