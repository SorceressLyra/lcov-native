import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LcovParser } from './lcovParser';

export class CoverageService {
  private parser: LcovParser;
  private testController: vscode.TestController;
  private statusBarItem: vscode.StatusBarItem;
  private currentRun: vscode.TestRun | undefined;
  private lcovFilePath: string | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private context: vscode.ExtensionContext;
  private fileCoverageRecordMap = new WeakMap<vscode.FileCoverage, any>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.parser = new LcovParser();

    this.testController = vscode.tests.createTestController(
      'lcovCoverageController',
      'LCOV Coverage'
    );

    const profile = this.testController.createRunProfile(
      'LCOV Coverage',
      vscode.TestRunProfileKind.Coverage,
      async (request, token) => {
        // When the user runs coverage from the Testing view, 
        // we need to reload the current coverage file
        try {
          if (this.lcovFilePath) {
            console.log(`Running coverage using existing LCOV file: ${this.lcovFilePath}`);
            await this.loadCoverage(this.lcovFilePath);
          } else {
            console.log('No LCOV file selected yet, asking user to find one');
            await this.findAndLoadLcovFiles();
          }
        } catch (error) {
          console.error(`Error running coverage profile: ${error}`);
          vscode.window.showErrorMessage(`Failed to run coverage: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    profile.loadDetailedCoverage = async (run, fileCoverage, token) => {
      try {
        const uri = fileCoverage.uri;
        console.log(`Loading detailed coverage for ${uri.toString()}`);
        // Only return details for the exact FileCoverage instance
        const record = this.fileCoverageRecordMap.get(fileCoverage);
        if (record) {
          console.log('Found record in WeakMap for FileCoverage instance');
          const details = this.parser.loadDetailedCoverageForRecord(record);
          console.log(`Generated ${details.length} detailed coverage items`);
          return details;
        }
        // Fallback: try to find by URI
        const fileRecord = this.parser.getFileRecord(uri);
        if (fileRecord) {
          console.log('Found record by URI lookup');
          // Store in WeakMap for future lookups
          this.fileCoverageRecordMap.set(fileCoverage, fileRecord);
          const details = this.parser.loadDetailedCoverageForRecord(fileRecord);
          console.log(`Generated ${details.length} detailed coverage items`);
          return details;
        }
        console.log(`No coverage record found for ${uri.toString()}`);
        return [];
      } catch (error) {
        console.error(`Error loading detailed coverage: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.text = '$(shield) LCOV Coverage';
    this.statusBarItem.tooltip = 'Select LCOV file to show coverage';
    this.statusBarItem.show();

    // Group subscription registrations
    context.subscriptions.push(
      this.statusBarItem,
      this.testController,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('lcovCoverage')) {
          this.handleConfigurationChange();
        }
      })
    );

    // Auto-load coverage if configured
    const config = vscode.workspace.getConfiguration('lcovCoverage');
    if (config.get<boolean>('autoLoadCoverage', false)) {
      this.findAndLoadLcovFiles(true);
    }
  }

  /**
   * Select an LCOV file to show coverage
   */
  public async selectLcovFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        LCOV: ['lcov', 'info', 'dat']
      },
      title: 'Select LCOV File'
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const lcovUri = uris[0];
    this.lcovFilePath = lcovUri.fsPath;

    // Load coverage and set up file watcher
    await this.loadCoverage(lcovUri.fsPath);

    const config = vscode.workspace.getConfiguration('lcovCoverage');
    const watchFile = config.get<boolean>('watchLcovFile', true);
    if (watchFile) {
      this.registerFileWatcher(this.context, lcovUri.fsPath);
    }
  }

  /**
   * Load coverage from file path
   */
  public async loadCoverage(lcovFilePath: string): Promise<void> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Loading LCOV coverage',
      cancellable: true,
    }, async (progress, token) => {
      try {
        progress.report({ message: 'Initializing...', increment: 10 });

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('No workspace folder found.');
          return;
        }

        // Parse LCOV file and check for cancellation
        progress.report({ message: 'Parsing LCOV file...', increment: 20 });
        const records = await this.parser.parse(lcovFilePath);
        if (token.isCancellationRequested) return;

        if (records.length === 0) {
          vscode.window.showWarningMessage('No coverage data found in the LCOV file.');
          return;
        }

        // Calculate coverage stats
        progress.report({ message: 'Calculating coverage...', increment: 20 });
        const { totalLines, coveredLines, coveragePercentage } = this.calculateCoverageStats(records);
        if (token.isCancellationRequested) return;

        // Update UI with coverage information
        this.updateStatusBar(coveragePercentage, coveredLines, totalLines);

        // Create test run
        progress.report({ message: 'Applying coverage to editor...', increment: 20 });
        const run = this.createTestRun();
        if (token.isCancellationRequested) {
          run.end();
          return;
        }

        // Process files and add coverage
        await this.processCoverageFiles(
          run, records, workspaceFolder.uri, progress, token
        );

        // Show completion message
        progress.report({
          message: `✓ Coverage loaded: ${coveragePercentage}% (${coveredLines}/${totalLines} lines)`,
          increment: 10
        });

        // Brief delay to let users see the completion message
        await new Promise(resolve => setTimeout(resolve, 1500));

        run.end();
      } catch (error) {
        if (this.currentRun) {
          this.currentRun.end();
        }
        vscode.window.showErrorMessage(
          `Failed to load coverage: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Calculate coverage statistics from parsed LCOV records
   */
  private calculateCoverageStats(records: any[]) {
    let totalLines = 0;
    let coveredLines = 0;

    for (const record of records) {
      totalLines += record.lines.found;
      coveredLines += record.lines.hit;
    }

    const coveragePercentage = totalLines > 0 ?
      (coveredLines / totalLines * 100).toFixed(2) : '0';

    return { totalLines, coveredLines, coveragePercentage };
  }

  /**
   * Update the status bar with coverage information
   */
  private updateStatusBar(coveragePercentage: string, coveredLines: number, totalLines: number) {
    this.statusBarItem.text = `${coveragePercentage}% Coverage`;
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = `${coveredLines}/${totalLines} lines covered`;

    // End any existing run
    if (this.currentRun) {
      this.currentRun.end();
    }
  }

  /**
   * Create a new test run for coverage
   */
  private createTestRun() {
    const request = new vscode.TestRunRequest();
    const run = this.testController.createTestRun(request, 'LCOV Coverage', true);
    this.currentRun = run;
    return run;
  }

  /**
   * Process coverage files and add them to the test run
   */
  private async processCoverageFiles(
    run: vscode.TestRun,
    records: any[],
    workspaceUri: vscode.Uri,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) {
    progress.report({ message: 'Processing files...', increment: 20 });
    const fileCoverages = this.parser.convertToFileCoverage(records, workspaceUri);

    let filesProcessed = 0;
    const totalFiles = fileCoverages.length;
    
    // Log how many files have coverage details (essential for inline coverage)
    let filesWithLineDetails = 0;
    for (const record of records) {
      if (record.lines?.details && record.lines.details.length > 0) {
        filesWithLineDetails++;
      }
    }
    console.log(`Found ${filesWithLineDetails}/${records.length} files with line details required for inline coverage`);

    for (const coverage of fileCoverages) {
      if (token.isCancellationRequested) {
        run.end();
        return;
      }

      filesProcessed++;
      if (filesProcessed % 10 === 0 || filesProcessed === totalFiles) {
        progress.report({
          message: `Processing files (${filesProcessed}/${totalFiles})...`,
          increment: (filesProcessed === totalFiles) ? 20 : 0
        });
      }

      // Always use the FileCoverage instance from the parser
      const record = this.parser.getFileRecord(coverage.uri);
      if (record) {
        this.fileCoverageRecordMap.set(coverage, record);
      }
      run.addCoverage(coverage);
    }
  }

  /**
   * Handle configuration changes
   */
  private handleConfigurationChange(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }

    const config = vscode.workspace.getConfiguration('lcovCoverage');
    const autoLoad = config.get<boolean>('autoLoadCoverage', false);

    if (autoLoad) {
      this.findAndLoadLcovFiles(true);
    }
  }

  /**
   * Register file watcher for auto refresh
   */
  private registerFileWatcher(context: vscode.ExtensionContext, lcovFilePath: string): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(lcovFilePath), path.basename(lcovFilePath))
    );

    this.fileWatcher.onDidChange(async () => {
      await this.loadCoverage(lcovFilePath);
    });

    context.subscriptions.push(this.fileWatcher);
  }

  /**
   * Clear all coverage data
   */
  public clearCoverage(): void {
    if (this.currentRun) {
      this.currentRun.end();
      this.currentRun = undefined;
    }

    this.statusBarItem.text = '$(shield) LCOV Coverage';
    this.statusBarItem.tooltip = 'Select LCOV file to show coverage';

    vscode.window.showInformationMessage('Coverage data cleared.');
  }

  /**
   * Find LCOV files using glob patterns
   */
  private async findLcovFiles(pattern: string): Promise<vscode.Uri[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    try {
      return await vscode.workspace.findFiles(
        pattern,
        '**/node_modules/**'
      );
    } catch (error) {
      console.error('Error finding LCOV files:', error);
      return [];
    }
  }

  /**
   * Find and load LCOV files using default or configured glob pattern
   */
  public async findAndLoadLcovFiles(autoMode: boolean = false): Promise<void> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: autoMode ? 'Auto-loading LCOV coverage' : 'LCOV Coverage',
      cancellable: true
    }, async (progress, token) => {
      try {
        progress.report({ message: 'Initializing...', increment: 10 });

        const config = vscode.workspace.getConfiguration('lcovCoverage');
        const pattern = config.get<string>('lcovFilePath', '**/lcov.info');
        if (token.isCancellationRequested) return;

        // Find matching LCOV files
        progress.report({ message: 'Searching for LCOV files...', increment: 20 });
        const files = await this.findLcovFiles(pattern);
        if (token.isCancellationRequested) return;

        if (files.length === 0) {
          vscode.window.showWarningMessage(`No LCOV files found matching pattern: ${pattern}`);
          return;
        }

        // Determine which file to use
        let selectedFile: vscode.Uri;

        if (files.length === 1 || autoMode) {
          // Single file or auto mode: use first file
          selectedFile = files[0];
          const message = files.length > 1 ?
            `Found ${files.length} LCOV files. Using: ${path.basename(selectedFile.fsPath)}` :
            `Found LCOV file: ${path.basename(selectedFile.fsPath)}`;

          progress.report({ message, increment: 10 });

        } else {
          // Multiple files: let user choose
          progress.report({ message: `Found ${files.length} LCOV files, preparing selection...`, increment: 10 });
          if (token.isCancellationRequested) return;

          const selectedItem = await this.promptForFileSelection(files);
          if (!selectedItem || token.isCancellationRequested) return;

          progress.report({ message: `Loading selected file: ${selectedItem.label}`, increment: 10 });
          selectedFile = selectedItem.file;
        }

        // Brief pause to let user see progress message
        await new Promise(resolve => setTimeout(resolve, autoMode ? 1000 : 500));
        if (token.isCancellationRequested) return;

        // Store selected path and load coverage
        this.lcovFilePath = selectedFile.fsPath;
        this.loadCoverage(selectedFile.fsPath);

        // Set up file watcher if needed
        const watchFile = config.get<boolean>('watchLcovFile', true);
        if (watchFile && !token.isCancellationRequested) {
          this.registerFileWatcher(this.context, selectedFile.fsPath);
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Error finding LCOV files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Prompt user to select from multiple LCOV files
   */
  private async promptForFileSelection(files: vscode.Uri[]) {
    const items = files.map(file => {
      let displayPath = file.fsPath;

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder && displayPath.startsWith(workspaceFolder.uri.fsPath)) {
        displayPath = displayPath.substring(workspaceFolder.uri.fsPath.length + 1);
      }

      return {
        label: path.basename(file.fsPath),
        description: displayPath,
        file: file
      };
    });

    return await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an LCOV file to load'
    });
  }

  /**
   * Diagnostic method to inspect coverage data for the current file
   * This is useful for debugging why inline coverage isn't showing
   */
  public async inspectCoverageDataForFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found');
      return;
    }

    const uri = editor.document.uri;
    if (!uri.scheme || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('Only file URIs are supported');
      return;
    }

    // Try to find the record for this file
    const record = this.parser.getFileRecord(uri);
    if (!record) {
      vscode.window.showWarningMessage(`No coverage record found for ${uri.fsPath}`);
      return;
    }

    // Create an output channel to display the coverage data
    const outputChannel = vscode.window.createOutputChannel('LCOV Coverage Debug');
    outputChannel.clear();
    outputChannel.appendLine(`--- LCOV Coverage Data for ${uri.fsPath} ---\n`);
    
    // Display summary information
    outputChannel.appendLine(`Summary:`);
    outputChannel.appendLine(`- Lines: ${record.lines.hit}/${record.lines.found} covered`);
    outputChannel.appendLine(`- Branches: ${record.branches.hit}/${record.branches.found} covered`);
    outputChannel.appendLine(`- Functions: ${record.functions.hit}/${record.functions.found} covered`);
    outputChannel.appendLine(`- Has line details: ${record.lines?.details ? 'Yes' : 'No'}`);
    outputChannel.appendLine(`- Line details count: ${record.lines?.details?.length || 0}`);
    outputChannel.appendLine(`- Branch details count: ${record.branches?.details?.length || 0}`);
    outputChannel.appendLine(`- Function details count: ${record.functions?.details?.length || 0}`);
    
    // Check if we have line details and display them
    if (record.lines?.details && record.lines.details.length > 0) {
      outputChannel.appendLine(`\nLine Coverage Details:`);
      
      // Get the first 20 line details
      const linesToShow = record.lines.details.slice(0, 20);
      for (const line of linesToShow) {
        outputChannel.appendLine(`- Line ${line.line}: ${line.hit > 0 ? 'Covered' : 'Not covered'} (${line.hit} hits)`);
      }
      
      if (record.lines.details.length > 20) {
        outputChannel.appendLine(`... and ${record.lines.details.length - 20} more lines`);
      }
    }
    
    // Create detailed coverage items and inspect them
    const detailedCoverageItems = this.parser.loadDetailedCoverageForRecord(record);
    outputChannel.appendLine(`\nDetailed Coverage Items: ${detailedCoverageItems.length}`);
    
    if (detailedCoverageItems.length > 0) {
      outputChannel.appendLine(`- Coverage items available: ${detailedCoverageItems.length}`);
      outputChannel.appendLine(`- First few covered line numbers: ${
        detailedCoverageItems
          .slice(0, 5)
          .map(item => {
            try {
              // Try to get the line number from the range property if it exists
              if ((item as any).range && (item as any).range.start) {
                return (item as any).range.start.line + 1;
              }
              return 'unknown';
            } catch (e) {
              return 'error';
            }
          })
          .join(', ')
      }`);
    }
    
    // Now let's check file path resolution issues
    outputChannel.appendLine(`\nFile Path Resolution:`);
    outputChannel.appendLine(`- LCOV file path: ${record.file}`);
    outputChannel.appendLine(`- VSCode file path: ${uri.fsPath}`);
    
    // Check if paths match directly
    if (uri.fsPath === record.file) {
      outputChannel.appendLine(`- Paths match exactly: Yes`);
    } else {
      outputChannel.appendLine(`- Paths match exactly: No`);
      
      // Check if one ends with the other
      if (uri.fsPath.endsWith(record.file)) {
        outputChannel.appendLine(`- VSCode path ends with LCOV path: Yes`);
      } else if (record.file.endsWith(uri.fsPath)) {
        outputChannel.appendLine(`- LCOV path ends with VSCode path: Yes`);
      } else {
        outputChannel.appendLine(`- Path suffix match: No`);
      }
      
      // Normalize paths for comparison
      const normalizedFilePath = uri.fsPath.replace(/\\/g, '/');
      const normalizedRecordPath = record.file.replace(/\\/g, '/');
      
      outputChannel.appendLine(`- Normalized VSCode path: ${normalizedFilePath}`);
      outputChannel.appendLine(`- Normalized LCOV path: ${normalizedRecordPath}`);
    }
    
    // Show a more complete test run
    outputChannel.appendLine(`\nAttempting to generate a test run with coverage for this file only...`);
    
    try {
      // Create a new test run specifically for this file
      const run = this.createTestRun();
      
      // Generate detailed coverage for visualization
      const details = this.parser.loadDetailedCoverageForRecord(record);
      
      if (details.length > 0) {
        // Create and add coverage
        const fileCoverage = vscode.FileCoverage.fromDetails(uri, details);
        run.addCoverage(fileCoverage);
        this.fileCoverageRecordMap.set(fileCoverage, record);
        
        outputChannel.appendLine(`✓ Successfully created a test run with coverage.`);
        outputChannel.appendLine(`- Coverage added for ${uri.fsPath} with ${details.length} coverage items`);
        outputChannel.appendLine(`- Open the file to see if coverage is shown`);
      } else {
        outputChannel.appendLine(`⚠ Generated coverage details, but got zero items.`);
      }
    } catch (error) {
      outputChannel.appendLine(`⚠ Error creating test run: ${error}`);
    }
    
    // Show the output channel
    outputChannel.show();
    
    vscode.window.showInformationMessage(`Coverage data for ${path.basename(uri.fsPath)} has been shown in the output panel.`);
  }
}
