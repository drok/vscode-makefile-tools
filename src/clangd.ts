import * as vscode from 'vscode';
// import type { ClangdExtension, ASTParams, ASTNode } from '@clangd/vscode-clangd';
// import type { ClangdExtension } from '@clangd/vscode-clangd';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;

const ASTRequestMethod = 'textDocument/ast';

export function clangExtension(): vscode.Extension<any> | undefined {

    return vscode.extensions.getExtension(CLANGD_EXTENSION);
};
