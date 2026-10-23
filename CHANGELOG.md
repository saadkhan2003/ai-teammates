# Changelog

## v0.4.0

### Added
- Companion CLI for pairing, status, and heartbeats.
- Settings → Computer device registration and permissions.

### Changed
- Web app and API identify this release as v0.4.

### Fixed
- Device heartbeats report current execution and traffic permissions.

### Security
- Companion credentials use mode 600 and are never sent in URLs or logs.
- `off` refuses command execution and `ask` requires terminal confirmation.
