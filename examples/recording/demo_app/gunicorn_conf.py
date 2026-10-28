# Gunicorn settings for the recording examples. The two forkscape_markers lines are all a workload needs for markers:
# a marker for each server hook, a slice for each request, and a slice for each import (such as the preloaded app's).
# Without FORKSCAPE_MARKERS in the environment they do nothing.
import forkscape_markers

forkscape_markers.gunicorn(globals())
forkscape_markers.trace_imports(depth=3)
