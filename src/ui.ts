// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();
const recursiveString = localize("recursive", "(recursive)");

let ui: UI;

export enum UIStatus {
    OK = 0,
    WARN = 1,
    ERR = 2,
    /* Bugs like thrown exceptions */
    RUNTIME = 3,
    /* Other error conditions */
    NO_MAKEFILE = 4,
}

export class UI {
    private configuration: string;
    private configurationButton: vscode.StatusBarItem;
    static colors: vscode.ThemeColor[] = [
        new vscode.ThemeColor("statusBar.background"),
        new vscode.ThemeColor("statusBarItem.warningBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
    ];
    static fgcolors: vscode.ThemeColor[] = [
        new vscode.ThemeColor("statusBar.foreground"), /* OK */
        new vscode.ThemeColor("statusBarItem.warningForeground"), /* WARN */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* ERR */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* RUNTIME */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* NO_MAKEFILE */
    ];

    /* When a new configuration is set, it is shown as 'loading' */
    public setConfiguration(configuration: string): void {
        this.configuration = configuration;
        this.configurationButton.text = '$(loading~spin) ' + configuration;
    }

    public setStatus(status: UIStatus): void {
        this.configurationButton.backgroundColor = UI.colors[status];
        this.configurationButton.color = UI.fgcolors[status];
        switch (status) {
            case UIStatus.NO_MAKEFILE:
                this.configurationButton.tooltip = localize("autotools.report.no.makefine", "The configuration is not initialized; There is no Makefile.");
                break;
            case UIStatus.RUNTIME:
                this.configurationButton.tooltip = localize("autotools.report.bug", "Runtime Error; please report bug.");
                this.configurationButton.text = "$(tools) $(bug)";
                break;
        }
    }

    public setLoading(loading: boolean): void {
        this.configurationButton.text = (loading ? '$(loading~spin) ' : '$(tools) ') + this.configuration;
    }

    public constructor() {
        this.configuration = '...'
        this.configurationButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4.6);
        this.configurationButton.command = "autotools.setBuildConfiguration";
        this.configurationButton.tooltip = localize("autotools.click.setconfig", "Click to select another build configuration");
        this.configurationButton.backgroundColor = UI.colors[UIStatus.OK];
        this.configurationButton.color = UI.fgcolors[UIStatus.OK];
        this.configurationButton.show();
    }

    public dispose(): void {
        this.configurationButton.dispose();
    }
}

export function getUI(): UI {
    if (ui === undefined) {
        ui = new UI();
    }

    return ui;
}
