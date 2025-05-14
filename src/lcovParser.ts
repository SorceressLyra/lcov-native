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
  // Store a mapping of file URIs to their record data for detailed coverage
  private fileRecordMap = new Map<string, LcovFileRecord>();

  // Map from file URI string to FileCoverage instance
  private fileCoverageInstanceMap = new Map<string, vscode.FileCoverage>();
  
  /**
   * Clear the stored file records
   */
  public clearFileRecords(): void {
    this.fileRecordMap.clear();
    this.fileCoverageInstanceMap.clear();
  }
  
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

    // Clear previous records
    this.fileRecordMap.clear();
    this.fileCoverageInstanceMap.clear();

    for (const record of records) {
      try {
        // LCOV paths can be relative or absolute
        // Try to resolve them to workspace files in multiple ways
        
        // First, try treating the path as absolute
        let resolvedFilePath = record.file;
        let fileExists = false;
        
        // Check if the absolute path exists
        if (path.isAbsolute(record.file)) {
          if (!fileExistsCache.has(record.file)) {
            fileExistsCache.set(record.file, fs.existsSync(record.file));
          }
          fileExists = fileExistsCache.get(record.file) || false;
        }
        
        // If the absolute path doesn't exist, try joining with workspace folder
        if (!fileExists) {
          resolvedFilePath = path.join(workspaceFolder.fsPath, record.file);
          
          if (!fileExistsCache.has(resolvedFilePath)) {
            fileExistsCache.set(resolvedFilePath, fs.existsSync(resolvedFilePath));
          }
          
          fileExists = fileExistsCache.get(resolvedFilePath) || false;
        }
        
        // If still not found, try a simple filename match as a last resort
        if (!fileExists) {
          const fileName = path.basename(record.file);
          console.log(`Trying to find file by name: ${fileName}`);
          
          // Try some common source directories
          const commonDirs = ['src', 'lib', 'app', 'components'];
          
          for (const dir of commonDirs) {
            const potentialPath = path.join(workspaceFolder.fsPath, dir, fileName);
            
            if (!fileExistsCache.has(potentialPath)) {
              fileExistsCache.set(potentialPath, fs.existsSync(potentialPath));
            }
            
            if (fileExistsCache.get(potentialPath)) {
              resolvedFilePath = potentialPath;
              fileExists = true;
              console.log(`Found file in common directory: ${dir}/${fileName}`);
              break;
            }
          }
        }
        
        // Skip if the file doesn't exist
        if (!fileExists) {
          console.log(`File not found for LCOV record ${record.file}`);
          continue;
        }
        
        // Create URI from the resolved file path
        const uri = vscode.Uri.file(resolvedFilePath);
        
        // Store the record in our map for later detailed coverage loading
        // Also store with the file path for more flexible lookup
        const uriString = uri.toString();
        this.fileRecordMap.set(uriString, record);
        
        // Debug logging
        console.log(`Mapped coverage data for ${uriString} (${record.file})`);
        console.log(`- Lines: ${record.lines.hit}/${record.lines.found}`);
        
        if (record.lines.details) {
            console.log(`- Line details count: ${record.lines.details.length}`);
        }
        
        if (record.branches.details) {
            console.log(`- Branch details count: ${record.branches.details.length}`);
        }
        
        if (record.functions.details) {
            console.log(`- Function details count: ${record.functions.details.length}`);
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
        const fileCoverage = new vscode.FileCoverage(
          uri, 
          statementCoverage, 
          branchCoverage,
          declarationCoverage
        );

        // Store the FileCoverage instance for this URI
        this.fileCoverageInstanceMap.set(uri.toString(), fileCoverage);
        
        // Note: We're now using fileRecordMap instead of a WeakMap
        
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
    console.log('Loading detailed coverage for record:', record.file);
    const details: vscode.FileCoverageDetail[] = [];
    
    // Verify that we have line details - this is essential for inline coverage
    if (!record.lines?.details || record.lines.details.length === 0) {
      console.warn(`Record has no line details; inline coverage will not work`);
      return [];
    }
    
    console.log(`Record has ${record.lines.details.length} line details, ${record.branches?.details?.length || 0} branch details, and ${record.functions?.details?.length || 0} function details`);
    
    // First, collect all branches by line for faster lookups
    const branchesByLine: Map<number, vscode.BranchCoverage[]> = new Map();
    
    // Add branch information if available
    if (record.branches?.details && record.branches.details.length > 0) {
      for (const branch of record.branches.details) {
        if (!branchesByLine.has(branch.line)) {
          branchesByLine.set(branch.line, []);
        }
        
        // Create a range for the branch - use column information if possible
        // If not, default to the beginning of the line
        const position = new vscode.Position(branch.line - 1, 0);
        
        const branchCoverage = new vscode.BranchCoverage(
          branch.taken > 0,  // Boolean indicating if executed
          position,
          `Branch ${branch.block}:${branch.branch} ${branch.taken > 0 ? 'taken' : 'not taken'}`
        );
        
        branchesByLine.get(branch.line)?.push(branchCoverage);
      }
      
      console.log(`Collected branches for ${branchesByLine.size} distinct lines`);
    } else {
      console.log('No branch details available in the record');
    }
    
    // Process function declarations first (to ensure proper z-ordering in VS Code)
    const processedLines = new Set<number>();
    if (record.functions?.details && record.functions.details.length > 0) {
      console.log(`Processing ${record.functions.details.length} function details`);
      
      for (const func of record.functions.details) {
        if (func.line > 0) { // Ensure line number is valid
          const range = new vscode.Range(
            func.line - 1, 0,  // Start of line (0-based)
            func.line - 1, Number.MAX_SAFE_INTEGER // End of line
          );
          
          details.push(new vscode.DeclarationCoverage(
            func.name,
            func.hit > 0, // Boolean indicating if executed
            range
          ));
          
          // Mark this line as processed so we don't duplicate with statement coverage
          processedLines.add(func.line);
        }
      }
    } else {
      console.log('No function details available in the record');
    }
    
    // Add line coverage details with branch information
    console.log(`Processing ${record.lines.details.length} line details`);
    for (const line of record.lines.details) {
      // Skip lines that already have function coverage
      if (processedLines.has(line.line)) {
        continue;
      }
      
      // Create a range covering the entire line
      const range = new vscode.Range(
        line.line - 1, 0,  // Start of line (0-based)
        line.line - 1, Number.MAX_SAFE_INTEGER // End of line
      );
      
      // Get branches for this line, if any
      const branches = branchesByLine.get(line.line) || [];
      
      // Create statement coverage with hit count and branch information
      const executed = line.hit > 0 ? line.hit : false; // Use actual hit count if available
      
      if (branches.length > 0) {
        details.push(new vscode.StatementCoverage(executed, range, branches));
      } else {
        details.push(new vscode.StatementCoverage(executed, range));
      }
    }
    
    console.log(`Created ${details.length} FileCoverageDetail items`);
    return details;
  }
  
  /**
   * Get a file record by its URI
   * @param uri The file URI
   */
  public getFileRecord(uri: vscode.Uri): LcovFileRecord | undefined {
    const uriString = uri.toString();
    const record = this.fileRecordMap.get(uriString);
    
    // Try to find the record directly
    if (record) {
      console.log(`Found record directly by URI string: ${uriString}`);
      return record;
    }
    
    // If not found directly, try to match by file path
    // This helps when paths in LCOV file don't perfectly match VS Code URIs
    const filePath = uri.fsPath;
    console.log(`Looking for file path match: ${filePath}`);
    
    // Try multiple matching strategies
    for (const [key, value] of this.fileRecordMap.entries()) {
      // Strategy 1: Direct file path match
      if (value.file === filePath) {
        console.log(`Found record by direct file path match: ${value.file}`);
        this.fileRecordMap.set(uriString, value); // Cache for future lookups
        return value;
      }
      
      // Strategy 2: File path ends with record path (handles relative paths)
      if (filePath.endsWith(value.file)) {
        console.log(`Found record by file path suffix match: ${value.file}`);
        this.fileRecordMap.set(uriString, value); // Cache for future lookups
        return value;
      }
      
      // Strategy 3: Normalize paths by replacing backslashes with forward slashes (for Windows)
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      const normalizedRecordPath = value.file.replace(/\\/g, '/');
      
      if (normalizedFilePath.endsWith(normalizedRecordPath)) {
        console.log(`Found record by normalized path suffix match: ${normalizedRecordPath}`);
        this.fileRecordMap.set(uriString, value); // Cache for future lookups
        return value;
      }
      
      // Strategy 4: Match by filename only (last resort)
      const fileName = path.basename(filePath);
      const recordFileName = path.basename(value.file);
      
      if (fileName === recordFileName) {
        // This is risky but might help in some cases - log that we're using it
        console.log(`Found record by filename match (may be inaccurate): ${recordFileName}`);
        console.log(`  VS Code path: ${filePath}`);
        console.log(`  LCOV path: ${value.file}`);
        this.fileRecordMap.set(uriString, value); // Cache for future lookups
        return value;
      }
    }
    
    // No match found
    console.log(`No record found for ${filePath}`);
    return undefined;
  }
  
  /**
   * Load detailed coverage information for a file URI
   * @param uri The file URI
   */
  public loadDetailedCoverage(uri: vscode.Uri): vscode.FileCoverageDetail[] {
    try {
      // Extract the file path from the URI
      const filePath = uri.fsPath;
      const uriString = uri.toString();
      console.log(`Looking for coverage record for: ${filePath} (${uriString})`);
      
      // First, try to look up by URI string directly - this is most reliable
      let record = this.fileRecordMap.get(uriString);
      
      // If not found directly, try the more flexible getFileRecord method
      if (!record) {
        console.log(`No direct record match, trying flexible matching`);
        record = this.getFileRecord(uri);
      }
      
      if (!record) {
        console.log(`No coverage record found for file: ${uriString}`);
        
        // Diagnostic logging: Show all available records
        console.log('Available file records:');
        for (const [key, value] of this.fileRecordMap.entries()) {
          console.log(`  - ${key} -> ${value.file}`);
        }
        
        return [];
      }
      
      // Generate detailed coverage objects from the record
      const details = this.loadDetailedCoverageForRecord(record);
      
      if (details.length === 0) {
        console.log(`Record found for ${uri.toString()}, but no line/branch details available`);
        console.log(`Record summary: Lines: ${record.lines.hit}/${record.lines.found}, Branches: ${record.branches.hit}/${record.branches.found}, Functions: ${record.functions.hit}/${record.functions.found}`);
      } else {
        console.log(`Loaded ${details.length} coverage details for file: ${uri.toString()}`);
      }
      
      return details;
    } catch (error) {
      console.error(`Error loading detailed coverage for ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Get the FileCoverage instance for a given URI string
   */
  public getFileCoverageInstance(uri: vscode.Uri): vscode.FileCoverage | undefined {
    return this.fileCoverageInstanceMap.get(uri.toString());
  }

  /**
   * Get all entries from the fileRecordMap for diagnostics
   */
  public getRecordEntries(): [string, LcovFileRecord][] {
    return Array.from(this.fileRecordMap.entries());
  }

  /**
   * Get the total number of records in the fileRecordMap
   */
  public getRecordCount(): number {
    return this.fileRecordMap.size;
  }
}
