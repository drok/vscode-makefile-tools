import * as vscode from 'vscode';
import * as configuration from './configuration';
import { DebugConfigurationProvider, WorkspaceFolder, DebugConfiguration, ProviderResult } from 'vscode';

class MyDebugProvider implements DebugConfigurationProvider {
  provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
    // Return an array of debug configurations
    return [
      {
        type: 'autotools',
        name: 'Autotool Test Debug',
        request: 'launch',
        program: "zzz", // configuration.getDebugProgram(), // Get the program to be debugged
        // Additional configuration properties specific to cppdbg debugger
      }
    ];
  }

  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration): ProviderResult<DebugConfiguration> {
    // If needed, modify the debug configuration before launching the debug session
    if (config.type != "autotools")
        return undefined;
    config.type = "cppdbg";
    return config;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new MyDebugProvider();
  // Register the debug configuration provider
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('autotools', provider,
        vscode.DebugConfigurationProviderTriggerKind.Dynamic));
}
