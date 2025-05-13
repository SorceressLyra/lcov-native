# Change Log

All notable changes to the "lcov-coverage" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- Initial release with LCOV file parsing and native VS Code test coverage visualization
- Auto-finding LCOV files using glob patterns (defaults to **/lcov.info)
- Coverage threshold validation (default 75%)
- Progress indicators for file search and coverage processing
- Status bar indicator showing coverage percentage
- Auto-reload when coverage files change