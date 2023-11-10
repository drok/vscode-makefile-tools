// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Tree.ts

import * as configuration from './configuration';
import * as path from 'path';
import * as util from './util';
import { BuildTarget, t_none } from './make';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { extension } from './extension';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface NamedItem {
    name: string;
}

abstract class BaseNode {
    constructor(public readonly id: string) { }
    abstract getTreeItem(): vscode.TreeItem;
    abstract getChildren(): BaseNode[];
}

export class BuildTargetNode extends BaseNode {
    constructor(targetName: BuildTarget) {
        super(`buildTarget:${targetName.goal}@${targetName.builddir}`);
        this._name = targetName.goal;
    }

    _name: string;

    update(targetName: BuildTarget): void {
        this._name = localize("tree.build.target", "Build target: {0}", `[${targetName.goal} @ ${targetName.builddir}]`);
    }

    getChildren(): BaseNode[] {
        return [];
    }

    getTreeItem(): vscode.TreeItem {
        try {
            const item: vscode.TreeItem = new vscode.TreeItem(this._name);
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
            item.contextValue = [
                `nodeType=buildTarget`,
            ].join(',');
            return item;
        } catch (e) {
            return new vscode.TreeItem(localize("issue.rendering.item", "{0} (there was an issue rendering this item)", this._name));
        }
    }

}

export class ConfigurationNode extends BaseNode {
    constructor(configurationName: string) {
        super(`configuration:${configurationName}`);
        this._name = configurationName;
    }

    _name: string;

    update(configurationName: string): void {
        this._name = localize("tree.configuration", "Configuration: {0}", `[${configurationName}]`);
    }

    getChildren(): BaseNode[] {
        return [];
    }

    getTreeItem(): vscode.TreeItem {
        try {
            const item: vscode.TreeItem = new vscode.TreeItem(this._name);
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.tooltip = "The makefile configuration currently selected from settings ('autotools.configurations').";
            item.contextValue = [
                `nodeType=configuration`,
            ].join(',');
            return item;
        } catch (e) {
            return new vscode.TreeItem(localize("issue.rendering.item", "{0} (there was an issue rendering this item)", this._name));
        }
    }

}

export class ProjectOutlineProvider implements vscode.TreeDataProvider<BaseNode> {
    private readonly _changeEvent = new vscode.EventEmitter<BaseNode | null>();
    private readonly _unsetString = localize("Unset", "Unset");

    constructor() {
        this._currentConfigurationItem = new ConfigurationNode(this._unsetString);
        this._currentBuildTargetItem = new BuildTargetNode(t_none);
    }

    private _currentConfigurationItem: ConfigurationNode;
    private _currentBuildTargetItem: BuildTargetNode;

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    async getTreeItem(node: BaseNode): Promise<vscode.TreeItem> {
        return node.getTreeItem();
    }
    getChildren(node?: BaseNode): BaseNode[] {
        if (node) {
            return node.getChildren();
        }
        if (configuration.isOptionalFeatureEnabled("debug") || configuration.isOptionalFeatureEnabled("run")) {
            return [this._currentConfigurationItem,
                    this._currentBuildTargetItem];
        } else {
            return [this._currentConfigurationItem,
                    this._currentBuildTargetItem];
        }
     }

    pathDisplayed(pathInSettings: string | undefined, kind: string, searchInPath: boolean, makeRelative: boolean): string {
       if (!pathInSettings) {
         return `${kind}: [Unset]`;
       }
       
       const pathBase: string | undefined = (searchInPath && path.parse(pathInSettings).dir === "") ? path.parse(pathInSettings).base : undefined;
       const pathInEnv: string | undefined = pathBase ? (path.join(util.toolPathInEnv(pathBase) || "", pathBase)) : undefined;
       const finalPath: string = pathInEnv || pathInSettings;
       let checkFileExists: boolean = pathInSettings !== undefined;

       return (!checkFileExists ? `${kind} (not found)` : `${kind}`) + `: [${makeRelative ? util.makeRelPath(finalPath, util.getWorkspaceRoot()) : finalPath}]`;
    }

    async update(configuration: string | undefined,
                 buildTarget: BuildTarget): Promise<void> {
        this._currentConfigurationItem.update(configuration || this._unsetString);
        this._currentBuildTargetItem.update(buildTarget);

        this.updateTree();
    }

    updateConfiguration(configuration: string): void {
        this._currentConfigurationItem.update(configuration);
        this.updateTree();
    }

    updateBuildTarget(buildTarget: BuildTarget): void {
        this._currentBuildTargetItem.update(buildTarget);
        this.updateTree();
    }

    updateTree(): void {
        this._changeEvent.fire(null);
    }
}
