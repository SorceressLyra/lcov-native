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
      (request, token) => {}
    );
    
    profile.loadDetailedCoverage = async (run, fileCoverage, token) => {
      try {
        console.log(`Loading detailed coverage for ${fileCoverage.uri.toString()}`);

        if (!fileCoverage.uri.scheme || fileCoverage.uri.scheme === 'file') {
          // First try WeakMap, then URI lookup
          const record = this.fileCoverageRecordMap.get(fileCoverage) || 
                         this.parser.getFileRecord(fileCoverage.uri);
          
          if (record) {
            return this.parser.loadDetailedCoverageForRecord(record);
          }
          
          console.log(`No coverage record found for ${fileCoverage.uri.toString()}`);
        } else {
          console.log(`Unsupported URI scheme: ${fileCoverage.uri.scheme}`);
        }
        
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
          
          // In auto mode with multiple files, also show a notification
          if (files.length > 1 && autoMode) {
            vscode.window.showInformationMessage(message);
          }
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
}
