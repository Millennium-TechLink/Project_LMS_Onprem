r"""
Example deployment hooks for one on-prem install.

Use it with:  .\onprem\run_onprem.ps1 -Mode App -HooksModule onprem\docs\examples\customer_hooks.example.py
(or -Mode Local to try it on localhost). The file is copied to backend/app/customer_hooks.py for
that run only. Hooks do nothing outside on-prem mode, and a failing hook is logged, not fatal,
unless it is registered with required=True.
"""
import logging

from app.core import deployment

logger = logging.getLogger("customer_hooks")


@deployment.hook(deployment.HOOK_CONFIG, priority=10)
def check_settings(settings):
    # Runs before the database is touched: a good place to refuse an unsafe configuration.
    if not settings.SECRET_KEY or settings.SECRET_KEY.startswith("changeme"):
        raise RuntimeError("SECRET_KEY is not set for this install")


# required=True: if this fails, the backend does not start
@deployment.hook(deployment.HOOK_MIGRATED, required=True)
def seed_install_data(settings):
    # The schema is ready here, so install-specific rows can be created safely.
    logger.info("Seeding install-specific data")


@deployment.hook(deployment.HOOK_STARTUP)
def on_start(app):
    # The FastAPI app is available, so routes or background jobs can be added here.
    logger.info("Customer startup hook ran")


@deployment.hook(deployment.HOOK_SHUTDOWN)
def on_stop(app):
    # Runs on a graceful stop (e.g. Ctrl+C on a source run), not when the installed app closes.
    # For example: copy a final database backup to the customer's NAS or an S3 bucket.
    logger.info("Customer shutdown hook ran")
