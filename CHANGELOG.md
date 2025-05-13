# Change Log

All notable changes to the "lcov-coverage" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.3] - 2025-05-13

### Fixed
- Fixed inline coverage not working in editor by correcting the loadDetailedCoverage callback
- Added advanced file path resolution to better match LCOV records with actual files
- Improved debug logging and error handling
- Enhanced branch and statement coverage for better visualization

## [0.0.2] - 2025-05-13

### Changed
- Removed threshold validation to simplify the UI
- Enhanced inline coverage visualization with better branch and function details
- Improved performance and user experience

### Fixed
- Fixed inline coverage visualization not displaying properly in editor
- Improved file path matching for more accurate coverage detection
- Enhanced logging for better troubleshooting
- Better handling of branch coverage details

## [0.0.1] - Initial Release

### Added
- Initial release with LCOV file parsing and native VS Code test coverage visualization
- Auto-finding LCOV files using glob patterns (defaults to **/lcov.info)
- Progress indicators for file search and coverage processing
- Status bar indicator showing coverage percentage
- Auto-reload when coverage files change