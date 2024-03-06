// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Support for integration with CppTools Custom Configuration Provider

import * as configuration from './configuration';
import * as logger from './logger';
import * as make from './make';
import * as toolParser from './parser/tool';
import * as path from 'path';
import * as util from './util';
import * as vscode from 'vscode';
import { WorkspaceFolder } from 'vscode';
import * as cpp from 'vscode-cpptools';
import { Extension } from './extension';
import { config } from 'vscode-nls';

export interface SourceFileConfigurationItem extends cpp.SourceFileConfigurationItem {
    readonly compileCommand: toolParser.CompileCommand;
}

export interface CustomConfigurationProvider {
    workspaceBrowse: cpp.WorkspaceBrowseConfiguration;
    fileIndex: Map<string, SourceFileConfigurationItem>;
}

export interface CustomConfigProviderItem {
    defines: string[];
    includes: string[];
    forcedIncludes: string[];
    standard?: util.StandardVersion;
    intelliSenseMode?: util.IntelliSenseMode;
    compilerFullPath: string;
    compilerArgs: string[];
    files: string[];
    windowsSDKVersion?: string;
    currentPath: string;
    line: string;
}

export class CppConfigurationProvider implements cpp.CustomConfigurationProvider {
    public readonly name;//  = 'Autotools Integration';
    public readonly extensionId = Extension.whoami;

    constructor() {
        this.name = 'Autotools Integration';

    }
    private workspaceBrowseConfiguration: cpp.WorkspaceBrowseConfiguration = { browsePath: [] };
    private getConfiguration(uri: vscode.Uri): SourceFileConfigurationItem | undefined {
        let folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            let fc = configuration.getFolderConfig(folder);
            if (fc) {
                let norm_path: string = path.normalize(uri.fsPath);
                if (process.platform === "win32") {
                   norm_path = norm_path.toUpperCase();
                }
                return fc.cppConfigurationProvider.fileIndex.get(norm_path);
            }
        }
        return undefined;
    }

    public async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {
        let can = !!vscode.workspace.getWorkspaceFolder(uri);
        if (!can) {
            can = !!configuration.findFolderConfigByTarget(uri);
        }
        return can;
    }

    public async provideConfigurations(uris: vscode.Uri[]): Promise<cpp.SourceFileConfigurationItem[]> {
        let configs: SourceFileConfigurationItem[] = util.dropNulls(uris
            .map(u => this.getConfiguration(u)));
        return configs;
    }

    // Used when saving all the computed configurations into a cache.
    public getCustomConfigurationProvider(): CustomConfigurationProvider {
        let provider: CustomConfigurationProvider = {
            fileIndex: this.fileIndex,
            workspaceBrowse: this.workspaceBrowseConfiguration
        };

        return provider;
    }

    // Used to reset all the configurations with what was previously cached.
    public setCustomConfigurationProvider(provider: CustomConfigurationProvider): void {
        this.fileIndex = provider.fileIndex;
        this.workspaceBrowseConfiguration = provider.workspaceBrowse;
    }

    public async canProvideBrowseConfiguration(): Promise<boolean> {
        return this.workspaceBrowseConfiguration.browsePath.length > 0;
    }

    public async canProvideBrowseConfigurationsPerFolder(): Promise<boolean> {
        return true;
    }

    public async provideFolderBrowseConfiguration(_uri: vscode.Uri): Promise<cpp.WorkspaceBrowseConfiguration> {
        return this.workspaceBrowseConfiguration;
    }

    public async provideBrowseConfiguration(): Promise<cpp.WorkspaceBrowseConfiguration> {
        return this.workspaceBrowseConfiguration;
    }
    public setBrowseConfiguration(browseConfiguration: cpp.WorkspaceBrowseConfiguration): void {
        this.workspaceBrowseConfiguration =  browseConfiguration;
    }

    public dispose(): void { }

    private fileIndex = new Map<string, SourceFileConfigurationItem>();

    public logConfigurationProviderBrowse(): void {
        logger.message("Sending Workspace Browse Configuration: -----------------------------------", "Verbose");
        logger.message("    Browse Path: " + this.workspaceBrowseConfiguration.browsePath.join(";"), "Verbose");
        logger.message("    Standard: " + this.workspaceBrowseConfiguration.standard, "Verbose");
        logger.message("    Compiler Path: " + this.workspaceBrowseConfiguration.compilerPath, "Verbose");
        logger.message("    Compiler Arguments: " + this.workspaceBrowseConfiguration.compilerArgs?.join(";"), "Verbose");
        if (process.platform === "win32" && this.workspaceBrowseConfiguration.windowsSdkVersion) {
            logger.message("    Windows SDK Version: " + this.workspaceBrowseConfiguration.windowsSdkVersion, "Verbose");
        }
        logger.message("----------------------------------------------------------------------------", "Verbose");
    }

    public logConfigurationProviderItem(filePath: SourceFileConfigurationItem, fromCache: boolean = false): void {
        let uriObj: vscode.Uri = <vscode.Uri>filePath.uri;
        let when = "Debug";
        logger.message("Exporting config " + (fromCache ? "(from cache) " : "") + "for file " + uriObj.fsPath, "Verbose");
        logger.message("    Defines: " + filePath.configuration.defines.join(";"), when);
        logger.message("    Includes: " + filePath.configuration.includePath.join(";"), when);
        if (filePath.configuration.forcedInclude) {
            logger.message("    Force Includes: " + filePath.configuration.forcedInclude.join(";"), when);
        }
        logger.message("    Standard: " + filePath.configuration.standard, when);
        logger.message("    IntelliSense Mode: " + filePath.configuration.intelliSenseMode, when);
        logger.message("    Compiler Path: " + filePath.configuration.compilerPath, when);
        logger.message("    Compiler Arguments: " + filePath.configuration.compilerArgs?.join(";"), when);
        if (process.platform === "win32" && filePath.configuration.windowsSdkVersion) {
            logger.message("    Windows SDK Version: " + filePath.configuration.windowsSdkVersion, when);
        }
        logger.message("---------------------------------------------------------------------------------------------------", "Debug");
    }

    public logConfigurationProviderComplete(): void {
        if (configuration.getLoggingLevel() !== "Normal") {
            this.logConfigurationProviderBrowse();

            this.fileIndex.forEach(filePath => {
                // logConfigurationProviderComplete is called (so far) only after loading
                // the configurations from cache, so mark the boolean to be able to distinguish
                // the log entries in case of interleaved output.
                this.logConfigurationProviderItem(filePath, true);
            });
        }
    }
}
