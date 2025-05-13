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
  private fileCoverageDetailMap = new WeakMap<vscode.FileCoverage, string>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.parser = new LcovParser();
    
    // Create the test controller
    this.testController = vscode.tests.createTestController(
      'lcovCoverageController',
      'LCOV Coverage'
    );
    
    // Create a test run profile with a loadDetailedCoverage callback
    const profile = this.testController.createRunProfile(
      'LCOV Coverage',
      vscode.TestRunProfileKind.Coverage,
      (request, token) => {
        // This is empty since we add coverage manually
      }
    );
    
    // Add loadDetailedCoverage callback to provide inline coverage
    profile.loadDetailedCoverage = async (run, fileCoverage, token) => {
      try {
        console.log(`Loading detailed coverage for ${fileCoverage.uri.toString()}`);

        // Check if the URI is in a format that we support
        if (!fileCoverage.uri.scheme || fileCoverage.uri.scheme === 'file') {
          // First, check if we have this specific FileCoverage instance stored in our WeakMap
          // This is important as VS Code passes the same FileCoverage object to this callback
          const uriString = this.fileCoverageDetailMap.get(fileCoverage);
          
          if (uriString) {
            console.log(`Found cached URI string for this FileCoverage instance: ${uriString}`);
            
            // Get detailed coverage directly from the parser using the URI
            const details = this.parser.loadDetailedCoverage(fileCoverage.uri);
            
            if (details && details.length > 0) {
              console.log(`Found ${details.length} coverage details for ${fileCoverage.uri.toString()}`);
              return details;
            }
          } else {
            console.log(`No cached URI found for this FileCoverage instance, using URI directly.`);
          }
          
          // Fallback: Try to load detailed coverage directly from the URI
          const details = this.parser.loadDetailedCoverage(fileCoverage.uri);
          
          if (details && details.length > 0) {
            console.log(`Found ${details.length} coverage details for ${fileCoverage.uri.toString()}`);
            return details;
          } else {
            console.log(`No detailed coverage found for ${fileCoverage.uri.toString()}`);
            
            // Log more information about the FileCoverage object
            console.log(`FileCoverage details:`, {
              uri: fileCoverage.uri.toString(),
              statement: `${fileCoverage.statementCoverage.covered}/${fileCoverage.statementCoverage.total}`,
              branch: fileCoverage.branchCoverage ? 
                `${fileCoverage.branchCoverage.covered}/${fileCoverage.branchCoverage.total}` : 'none',
              declaration: fileCoverage.declarationCoverage ? 
                `${fileCoverage.declarationCoverage.covered}/${fileCoverage.declarationCoverage.total}` : 'none'
            });
          }
        } else {
          console.log(`Unsupported URI scheme: ${fileCoverage.uri.scheme}`);
        }
        
        return [];
      } catch (error) {
        console.error(`Error loading detailed coverage: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.text = '$(shield) LCOV Coverage';
    this.statusBarItem.tooltip = 'Select LCOV file to show coverage';
    this.statusBarItem.show();
    
    // Add to context
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this.testController);
    
    // Listen for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('lcovCoverage')) {
          this.handleConfigurationChange();
        }
      })
    );
    
    // Try to auto-load coverage from configured file
    this.autoLoadCoverage();
  }

  /**
   * Select an LCOV file to show coverage
   */
  public async selectLcovFile(): Promise<void> {
    // Show file picker
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
    
    // Load and show coverage
    await this.loadCoverage(lcovUri.fsPath);
  }

  /**
   * Load coverage from file path
   */
  public async loadCoverage(lcovFilePath: string): Promise<void> {
    // Show progress notification with longer display time
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Loading LCOV coverage',
      cancellable: true,
    }, async (progress, token) => {
      try {
        // Update progress
        progress.report({ message: 'Initializing...', increment: 10 });

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('No workspace folder found.');
          return;
        }
        
        // Parse LCOV file
        progress.report({ message: 'Parsing LCOV file...', increment: 20 });
        const records = await this.parser.parse(lcovFilePath);
        
        if (token.isCancellationRequested) {
          return;
        }
        
        if (records.length === 0) {
          vscode.window.showWarningMessage('No coverage data found in the LCOV file.');
          return;
        }

        // Calculate total coverage stats
        progress.report({ message: 'Calculating coverage...', increment: 20 });
        let totalLines = 0;
        let coveredLines = 0;
        
        for (const record of records) {
          totalLines += record.lines.found;
          coveredLines += record.lines.hit;
        }
        
        const coveragePercentage = totalLines > 0 ? (coveredLines / totalLines * 100).toFixed(2) : '0';
        
        if (token.isCancellationRequested) {
          return;
        }
        
        // Update status bar item
        this.statusBarItem.text = `${coveragePercentage}% Coverage`;
        this.statusBarItem.color = undefined; // Use default color
        this.statusBarItem.tooltip = `${coveredLines}/${totalLines} lines covered`;
        
        // End any existing test run before creating a new one
        if (this.currentRun) {
          this.currentRun.end();
        }
        
        // Create test run
        progress.report({ message: 'Applying coverage to editor...', increment: 20 });
        const request = new vscode.TestRunRequest();
        const run = this.testController.createTestRun(request, 'LCOV Coverage', true);
        this.currentRun = run;
        
        if (token.isCancellationRequested) {
          run.end();
          return;
        }
        
        // Convert to FileCoverage and add to the run
        progress.report({ message: 'Processing files...', increment: 20 });
        const fileCoverages = this.parser.convertToFileCoverage(records, workspaceFolder.uri);
        
        // Show files being processed
        let filesProcessed = 0;
        const totalFiles = fileCoverages.length;
        
        for (const coverage of fileCoverages) {
          if (token.isCancellationRequested) {
            run.end();
            return;
          }
          
          filesProcessed++;
          if (filesProcessed % 10 === 0 || filesProcessed === totalFiles) { // Update every 10 files
            progress.report({ 
              message: `Processing files (${filesProcessed}/${totalFiles})...`, 
              increment: (filesProcessed === totalFiles) ? 20 : 0
            });
          }
          
          // Store the URI string in the WeakMap before adding the coverage to the run
          this.fileCoverageDetailMap.set(coverage, coverage.uri.toString());
          
          run.addCoverage(coverage);
        }
         // Show completion message with coverage information in the progress notification
        progress.report({ 
          message: `✓ Coverage loaded: ${coveragePercentage}% (${coveredLines}/${totalLines} lines)`, 
          increment: 10 
        });
        
        // Add a small delay at the end so users can see the completion message
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        this.statusBarItem.text = `${coveragePercentage}% Coverage`;
        
        // Ensure the test run is properly ended
        run.end();
      } catch (error) {
        // End the test run in case of error
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
   * Handle configuration changes
   */
  private handleConfigurationChange(): void {
    // Clear existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    
    // Check if auto-load is enabled
    const config = vscode.workspace.getConfiguration('lcovCoverage');
    const autoLoad = config.get<boolean>('autoLoadCoverage', false);
    
    if (autoLoad) {
      this.autoLoadCoverage();
    }
  }

  /**
   * Auto-load coverage from configured file path
   */
  private async autoLoadCoverage(): Promise<void> {
    const config = vscode.workspace.getConfiguration('lcovCoverage');
    const autoLoad = config.get<boolean>('autoLoadCoverage', false);
    
    if (!autoLoad) {
      return;
    }
    
    const lcovFilePattern = config.get<string>('lcovFilePath', '**/lcov.info');
    
    if (!lcovFilePattern) {
      return;
    }

    // Always use the progress indicator for search
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Auto-loading LCOV coverage',
      cancellable: true
    }, async (progress, token) => {
      await this._autoLoadCoverageWithProgress(lcovFilePattern, progress, token);
    });
  }

  /**
   * Helper method for auto-loading coverage with progress reporting
   */
  private async _autoLoadCoverageWithProgress(
    lcovFilePattern: string, 
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    progress.report({ message: 'Searching for LCOV files...', increment: 30 });
    
    // Find files using glob pattern
    const files = await this.findLcovFiles(lcovFilePattern);
    
    if (token.isCancellationRequested) {
      return;
    }
    
    if (files.length === 0) {
      vscode.window.showWarningMessage(`No LCOV files found matching pattern: ${lcovFilePattern}`);
      return;
    }
    
    // Always use the first file when auto-loading
    const selectedFile = files[0];
    
    progress.report({ 
      message: `Found ${files.length} LCOV file(s). Loading coverage...`, 
      increment: 20 
    });
    
    // Store the selected file path
    this.lcovFilePath = selectedFile.fsPath;
    
    if (token.isCancellationRequested) {
      return;
    }
    
    progress.report({ message: `Starting to load coverage from ${path.basename(selectedFile.fsPath)}...`, increment: 20 });
    
    // Add a small delay to allow the user to read the message
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Load coverage with its own progress notification
    this.loadCoverage(selectedFile.fsPath);
    
    if (token.isCancellationRequested) {
      return;
    }
    
    // Set up file watcher if enabled
    const config = vscode.workspace.getConfiguration('lcovCoverage');
    const watchFile = config.get<boolean>('watchLcovFile', true);
    if (watchFile) {
      this.registerFileWatcher(this.context, selectedFile.fsPath);
    }
    
    if (files.length > 1) {
      vscode.window.showInformationMessage(
        `Found ${files.length} LCOV files matching pattern. Using: ${path.basename(selectedFile.fsPath)}`
      );
    }
  }

  /**
   * Register file watcher for auto refresh
   */
  private registerFileWatcher(context: vscode.ExtensionContext, lcovFilePath: string): void {
    // Dispose existing watcher if any
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    
    // Create new watcher based on file pattern
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(lcovFilePath), path.basename(lcovFilePath))
    );
    
    // Watch for file changes
    this.fileWatcher.onDidChange(async () => {
      await this.loadCoverage(lcovFilePath);
    });
    
    context.subscriptions.push(this.fileWatcher);
  }

  /**
   * Clear all coverage data
   */
  public clearCoverage(): void {
    // End the current test run
    if (this.currentRun) {
      this.currentRun.end();
      this.currentRun = undefined;
    }
    
    // Reset status bar
    this.statusBarItem.text = '$(shield) LCOV Coverage';
    this.statusBarItem.tooltip = 'Select LCOV file to show coverage';
    
    vscode.window.showInformationMessage('Coverage data cleared.');
  }

  /**
   * Find LCOV files using glob patterns
   */
  private async findLcovFiles(pattern: string, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<vscode.Uri[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    try {
      if (progress) {
        progress.report({ message: `Searching for LCOV files matching ${pattern}...`, increment: 20 });
      }
      
      // Use VS Code's built-in file search with the glob pattern
      const files = await vscode.workspace.findFiles(
        pattern,
        '**/node_modules/**' // Exclude node_modules
      );
      
      if (progress) {
        progress.report({ 
          message: `Found ${files.length} LCOV file(s)`,
          increment: 20
        });
      }
      
      return files;
    } catch (error) {
      console.error('Error finding LCOV files:', error);
      return [];
    }
  }

  /**
   * Placeholder for future validation logic
   * Thresholds have been removed
   */
  private validateThresholds(records: any[]): boolean {
    return true;
  }

  /**
   * Find and load LCOV files using default or configured glob pattern
   */
  public async findAndLoadLcovFiles(): Promise<void> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'LCOV Coverage',
      cancellable: true
    }, async (progress, token) => {
      try {
        progress.report({ message: 'Initializing...', increment: 10 });
        
        const config = vscode.workspace.getConfiguration('lcovCoverage');
        const pattern = config.get<string>('lcovFilePath', '**/lcov.info');
        
        if (token.isCancellationRequested) {
          return;
        }
        
        // Find LCOV files with progress reporting
        const files = await this.findLcovFiles(pattern, progress);
        
        if (token.isCancellationRequested) {
          return;
        }
        
        if (files.length === 0) {
          vscode.window.showWarningMessage(`No LCOV files found matching pattern: ${pattern}`);
          return;
        }
        
        let selectedFilePath: string;
        
        if (files.length === 1) {
          // Only one file found, use it directly
          progress.report({ message: `Found LCOV file: ${path.basename(files[0].fsPath)}`, increment: 10 });
          selectedFilePath = files[0].fsPath;
          
          if (token.isCancellationRequested) {
            return;
          }
          
          progress.report({ message: `Starting to load coverage from ${path.basename(files[0].fsPath)}...`, increment: 10 });
          
          // Add a small delay to allow the user to read the message
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          // Multiple files found, prepare for user selection
          progress.report({ message: `Found ${files.length} LCOV files, preparing selection...`, increment: 10 });
          
          if (token.isCancellationRequested) {
            return;
          }
          
          // Multiple files found, let the user pick one
          const items = files.map(file => {
            // Create relative path if possible
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
          
          // Show quick pick outside the progress dialog
          progress.report({ message: 'Waiting for file selection...', increment: 0 });
          
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an LCOV file to load'
          });
          
          if (!selected) {
            return;
          }
          
          if (token.isCancellationRequested) {
            return;
          }
          
          progress.report({ message: `Loading selected file: ${selected.label}`, increment: 10 });
          selectedFilePath = selected.file.fsPath;
        }
        
        // Store the selected file path
        this.lcovFilePath = selectedFilePath;
        
        // Load coverage with its own progress notification
        this.loadCoverage(selectedFilePath);
        
        // Set up file watcher if enabled
        const watchFile = config.get<boolean>('watchLcovFile', true);
        if (watchFile && !token.isCancellationRequested) {
          this.registerFileWatcher(this.context, selectedFilePath);
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Error finding LCOV files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }
}
