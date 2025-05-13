import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

// Import lcov-parse
const lcovParse = require('lcov-parse');
const parseLcov = promisify(lcovParse);

export interface LcovBranchDetail {
  line: number;
  block: number;
  branch: number;
  taken: number;
}

export interface LcovFunctionDetail {
  name: string;
  line: number;
  hit: number;
}

export interface LcovLineDetail {
  line: number;
  hit: number;
}

export interface LcovFileRecord {
  file: string;
  lines: {
    found: number;
    hit: number;
    details?: LcovLineDetail[];
  };
  functions: {
    found: number;
    hit: number;
    details?: LcovFunctionDetail[];
  };
  branches: {
    found: number;
    hit: number;
    details?: LcovBranchDetail[];
  };
}

export class LcovParser {
  /**
   * Parse an LCOV file and return coverage information
   * @param lcovFilePath Path to the lcov file
   */
  public async parse(lcovFilePath: string): Promise<LcovFileRecord[]> {
    try {
      // Check if file exists
      if (!fs.existsSync(lcovFilePath)) {
        throw new Error(`LCOV file not found: ${lcovFilePath}`);
      }

      // Read the lcov file
      const records = await parseLcov(lcovFilePath);
      return records as LcovFileRecord[];
    } catch (error) {
      vscode.window.showErrorMessage(`Error parsing LCOV file: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Convert LCOV records to VS Code FileCoverage instances
   * @param records LCOV records
   * @param workspaceFolder Workspace folder path to resolve file URIs
   */
  public convertToFileCoverage(records: LcovFileRecord[], workspaceFolder: vscode.Uri): vscode.FileCoverage[] {
    const result: vscode.FileCoverage[] = [];
    const fileExistsCache = new Map<string, boolean>();

    // Store records by file path for deferred detailed coverage loading
    const coverageData = new WeakMap<vscode.FileCoverage, LcovFileRecord>();

    for (const record of records) {
      try {
        // Create file URI
        const filePath = path.isAbsolute(record.file)
          ? record.file
          : path.join(workspaceFolder.fsPath, record.file);
        
        const uri = vscode.Uri.file(filePath);
        
        // Check if file exists (using cache to avoid repeated fs calls)
        if (!fileExistsCache.has(filePath)) {
          fileExistsCache.set(filePath, fs.existsSync(filePath));
        }
        
        if (!fileExistsCache.get(filePath)) {
          continue;
        }
        
        // Branch coverage
        const branchCoverage = record.branches.found > 0 
          ? { covered: record.branches.hit, total: record.branches.found }
          : undefined;
        
        // Function coverage
        const declarationCoverage = record.functions.found > 0
          ? { covered: record.functions.hit, total: record.functions.found }
          : undefined;
        
        // Line coverage
        const statementCoverage = {
          covered: record.lines.hit,
          total: record.lines.found
        };

        // Create FileCoverage instance with summary data only
        // Detailed statement coverage will be loaded on-demand when needed
        const fileCoverage = new vscode.FileCoverage(
          uri, 
          statementCoverage, 
          branchCoverage,
          declarationCoverage
        );
        
        // Store the record in the WeakMap for later detailed coverage loading
        coverageData.set(fileCoverage, record);
        
        result.push(fileCoverage);
      } catch (error) {
        console.error(`Error creating FileCoverage for ${record.file}:`, error);
      }
    }

    return result;
  }
  
  /**
   * Load detailed coverage information for a file
   * This is used by the loadDetailedCoverage callback
   * @param record LCOV record for the file
   */
  public loadDetailedCoverageForRecord(record: LcovFileRecord): vscode.FileCoverageDetail[] {
    const details: vscode.FileCoverageDetail[] = [];
    
    // Add line coverage details
    if (record.lines.details) {
      for (const line of record.lines.details) {
        const range = new vscode.Range(line.line - 1, 0, line.line - 1, Number.MAX_SAFE_INTEGER);
        details.push(new vscode.StatementCoverage(line.hit > 0, range));
      }
    }
    
    return details;
  }
}
