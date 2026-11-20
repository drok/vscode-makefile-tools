import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as configuration from './configuration';
import { FolderConfig } from './configuration';
import * as toolParser from './parser/tool';
import { CompileCommand } from './parser/tool';
import * as util from './util';
import * as logger from './logger';
import { Attributes, SpanStatusCode } from './tele';
import { Span } from '@opentelemetry/api';
import { extension, telemetry } from './extension';
import { clangExtension } from './clangd';

// Structure used to describe a compilation command. Reference documentation is
// hosted here https://clang.llvm.org/docs/JSONCompilationDatabase.html
export interface CompileCommandEntry {
    directory: string;
    file: string;
    arguments?: string[];
    output?: string;
}

interface CompilationDatabaseState {
    commands: Map<string, CompileCommandEntry>;
    outputFile: string;
    isEnabled: boolean;
}

const compilationDatabases: Map<string, CompilationDatabaseState> = new Map();
const emptyCommands: Map<string, CompileCommandEntry> = new Map();
/**
 * Get or create a compilation database for a folder config
 */
function getCompilationDatabase(fc: FolderConfig): CompilationDatabaseState {

    const clangd = clangExtension();
    if (!clangd || !clangd.isActive)
        return {
            commands: emptyCommands,
            outputFile: '',
            isEnabled: false
        };

    const key = fc.folder.uri.fsPath;
    let db = compilationDatabases.get(key);
    if (!db) {
        const outputFile = path.join(key, 'build', 'compile_commands.json');

        db = {
            commands: new Map(),
            outputFile,
            isEnabled: true
        };
        compilationDatabases.set(key, db);
    }

    return db;
}

/**
 * Convert a CustomConfigProviderItem to a CompileCommandEntry
 */
function itemToCompileCommand(compile_argv: string[], target: string, item: toolParser.CustomConfigProviderItem): CompileCommandEntry[] {
    const entries: CompileCommandEntry[] = [];

    item.files.forEach(filePath => {
        // Normalize the file path
        const normalizedFile = path.normalize(filePath);

        // Create a unique key for this file to avoid duplicates
        const key = normalizedFile;

        const entry: CompileCommandEntry = {
            directory: item.currentPath,
            file: normalizedFile,
            // command: item.line,
            output: target,
            arguments: compile_argv.length > 0 ? [item.compilerFullPath, ...compile_argv] : undefined
        };

        entries.push(entry);
    });

    return entries;
}

/**
 * Add compilation commands from a CustomConfigProviderItem to the database
 */
export function addCompilationCommands(fc: FolderConfig, compile_argv: string[], target: string, item: toolParser.CustomConfigProviderItem): void {
    const db = getCompilationDatabase(fc);

    if (!db.isEnabled) {
        return;
    }

    const entries = itemToCompileCommand(compile_argv, target, item);

    entries.forEach(entry => {
        // Use the file path as key to avoid duplicates
        const key = entry.file;
        db.commands.set(key, entry);
    });
}

/**
 * Write the compilation database to compile_commands.json
 */
export async function writeCompilationDatabase(fc: FolderConfig, span?: Span): Promise<void> {
    const db = getCompilationDatabase(fc);

    if (!db.isEnabled) {
        return;
    }

    const commands = Array.from(db.commands.values());

    if (commands.length === 0) {
        logger.message(`No compilation commands to write for ${fc.folder.name}`, 'Verbose');
        return;
    }

    try {
        // Ensure the build directory exists
        util.createDirectorySync(path.dirname(db.outputFile));

        // Write the compile_commands.json file
        const content = JSON.stringify(commands, null, 2);
        await util.writeFile(db.outputFile, content);

    } catch (error) {
        logger.message(`Failed to write compile_commands.json: ${error}`, 'Error');
        if (span) {
            telemetry.setSpanStatus(span, SpanStatusCode.ERROR, 'write_failed');
        }
    }
}

/**
 * Clear the compilation database for a folder
 */
export function clearCompilationDatabase(fc: FolderConfig): void {
    const key = fc.folder.uri.fsPath;
    compilationDatabases.delete(key);
}

/**
 * Enable or disable the compilation database for a folder
 */
export function setCompilationDatabaseEnabled(fc: FolderConfig, enabled: boolean): void {
    const db = getCompilationDatabase(fc);
    db.isEnabled = enabled;
}

/**
 * Get the path to the compile_commands.json file for a folder
 */
export function getCompilationDatabasePath(fc: FolderConfig): string {
    const db = getCompilationDatabase(fc);
    return db.outputFile;
}

/**
 * Get the number of compilation commands in the database
 */
export function getCompilationDatabaseSize(fc: FolderConfig): number {
    const db = getCompilationDatabase(fc);
    return db.commands.size;
}

