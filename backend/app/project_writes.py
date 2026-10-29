"""Shared in-process publication boundary for API and worker project writes."""
import threading

# Reentrant because storyboard restore and API handlers can call worker helpers.
# Deployment still requires one application process; this is not a distributed lock.
lock = threading.RLock()
