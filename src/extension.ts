// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CoverageService } from './coverageService';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	console.log('LCOV Coverage extension is now active!');

	// Initialize the coverage service
	const coverageService = new CoverageService(context);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('lcov-coverage.selectLcovFile', () => {
			coverageService.selectLcovFile();
		}),
		vscode.commands.registerCommand('lcov-coverage.clearCoverage', () => {
			coverageService.clearCoverage();
		}),
		vscode.commands.registerCommand('lcov-coverage.findLcovFiles', () => {
			coverageService.findAndLoadLcovFiles();
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
