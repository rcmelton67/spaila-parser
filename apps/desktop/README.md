# Spaila Desktop App

The current desktop implementation remains in `app/electron` and `app/ui` while Phase 1 web architecture is introduced.

Desktop remains authoritative for:

- Parser execution and learning
- Inbox ingestion
- Helper process control
- Backup and restore
- Local filesystem operations

Future migration can move these files into `apps/desktop` once shared web foundations are stable.
