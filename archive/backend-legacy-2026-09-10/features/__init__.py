# backend/features/__init__.py

"""
MindPal feature module registry.

All features are self-contained modules with clean public interfaces.
Feature sub-packages are loaded on-demand — this file intentionally
has no eager imports to avoid circular dependency chains between
feature route modules and api.dependencies.
"""
