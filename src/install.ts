import * as vscode from 'vscode';
import * as util from './util';
import * as path from 'path';
import { FolderConfig } from './configuration';

export async function installAutotools(fc: FolderConfig) : Promise<void> {
    const uri = vscode.Uri.from({
      scheme: 'untitled',
      path: path.join(fc.folder.uri.path, 'configure.ac')
    });
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    editor.edit(editBuilder => {
        editBuilder.insert(new vscode.Position(0, 0), `
AC_INIT([myProject], [1.0], [myemail@example.com])
AC_PREREQ([2.69])
AC_CONFIG_SRCDIR([src/main.c])
AC_CONFIG_HEADERS([config.h])

# The following build options:
# 1.13.2       = require at least automake 1.13.2 (2013/CentOS-7/Ubuntu-16),
#                when the parallel test suite became 'stable'.
# -Wall        = Automake will warn about: GNU coding standards,
#                obsolete, override (user redefines automake),
#                portability, extra-portability, syntax, and unsupported.
#                See the "Warning categories include:" section of
#                'automake --help' for exact meaning.
# -Werror      = Automake will "treat warnings as errors", to create
#                a high-quality, portable build
# dist-bzip2   = 'make dist' will produce a tar.bz2 source tarball
# no-dist-gzip = don't distribute in the tar.gz format
# See https://www.gnu.org/software/automake/manual/html_node/List-of-Automake-options.html
AM_INIT_AUTOMAKE([1.13.2 -Wall -Werror foreign dist-bzip2 no-dist-gzip])

# Find a C/C++ compiler, and define the CC variable.
AC_PROG_CC

# Find the install program
AC_PROG_INSTALL

# Test if the compiler supports C++
AC_LANG([C++])

# Libtool allows tests to be run on not-yet-installed shared libraries
AM_PROG_LIBTOOL

# Checks for libraries (used in the project)
PKG_CHECK_MODULES([LIBGMP], [libgmp], )
PKG_CHECK_MODULES([LIBCPPUNIT], [libcppunit])

# Output files
AC_CONFIG_FILES([
  Makefile
  src/Makefile
  man/Makefile
  lib/Makefile
  lib/myLibrary/Makefile
])

# Output messages
AC_OUTPUT
`)});
    return Promise.resolve();
}
