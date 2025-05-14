# LCOV Coverage

A simple VS Code extension that reads LCOV files and provides native VS Code test coverage visualization. This extension integrates with VS Code's built-in test coverage API to display code coverage information directly in your editor.

## Features

- Load coverage data from LCOV files (.lcov, .info, .dat)
- Display coverage information using VS Code's native test coverage UI
- Shows line, function, and branch coverage when available
- Status bar indicator showing total coverage percentage
- Auto-refresh coverage when LCOV file changes
- Progress indicators during file search and coverage processing
- Detailed inline coverage visualization in the editor

## Requirements

- VS Code version 1.100.0 or higher (for test coverage API support)

## Usage

1. Generate an LCOV coverage file from your test framework
   - Most test frameworks can generate LCOV format coverage files
   - Examples:
     - Jest: `jest --coverage`
     - Istanbul: `nyc --reporter=lcov`
     - Python: `pytest --cov=. --cov-report=lcov`
     - Flutter `flutter test --coverage`

2. Use the extension commands:
   - `LCOV: Find and Load Coverage Files` - Find and load LCOV files using the configured glob pattern
   - `LCOV: Select Coverage File` - Select and load a specific LCOV file
   - `LCOV: Clear Coverage` - Clear coverage visualization

## Configuration

This extension contributes the following settings:

* `lcovCoverage.autoLoadCoverage`: Enable/disable automatic loading of coverage on startup (default: `false`)
* `lcovCoverage.lcovFilePath`: Path or glob pattern for LCOV files (default: `**/lcov.info`)
* `lcovCoverage.watchLcovFile`: Watch LCOV file for changes and reload coverage (default: `true`)

## How It Works

This extension uses VS Code's Test Coverage API to display coverage information. When you load an LCOV file:

1. The extension parses the LCOV file
2. Converts the coverage data to VS Code's `FileCoverage` format
3. Displays coverage information directly in the editor

Coverage is displayed using:
- VS Code's native test coverage UI