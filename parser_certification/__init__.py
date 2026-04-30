"""Standalone parser certification harness.

This package is intentionally separate from the desktop runtime.  It runs the
parser as a black box with isolated temporary learning stores and emits
versioned certification reports for SaaS-scale assurance.
"""

from .runner import CertificationRunner, run_certification

__all__ = ["CertificationRunner", "run_certification"]

