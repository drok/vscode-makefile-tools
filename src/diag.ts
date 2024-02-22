import * as vscode from "vscode";
import { resolvePathToRoot } from "./util";
import { diag } from "@opentelemetry/api";

let diags : vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection("Autotools Diagnostics");


export function testDiag() {
    let loc = vscode.Uri.file(resolvePathToRoot("configure.ac"));
    let r : vscode.Range =
        new vscode.Range(new vscode.Position(10,1), new vscode.Position(10,30));

    let d : vscode.Diagnostic = new vscode.Diagnostic(
        r,
        "Test error from diag.ts",
        vscode.DiagnosticSeverity.Error);

    let r2 : vscode.Range =
        new vscode.Range(new vscode.Position(14,1), new vscode.Position(16,30));

    let d2 : vscode.Diagnostic = new vscode.Diagnostic(
        r2,
        "Test error TWO from diag.ts",
        vscode.DiagnosticSeverity.Error);

//    list.push(d2);

    diags.set(loc, [d, d2]);
}