"use strict";

import { execFile } from "child_process";
import * as vscode from "vscode";
import {
  Diagnostic,
  ExtensionContext,
  Range,
  TextDocument,
  WorkspaceFolder,
} from "vscode";

/**
 * Activate this extension.
 *
 * Install a formatter for fish files using fish_indent, and start linting fish
 * files for syntax errors.
 *
 * Initialization fails if Fish is not installed.
 *
 * @param context The context for this extension
 * @return A promise for the initialization
 */
export const activate = async (context: ExtensionContext): Promise<any> => {
  startLinting(context);
};

/**
 * Start linting Fish documents.
 *
 * @param context The extension context
 */
const startLinting = (context: ExtensionContext): void => {
  const diagnostics = vscode.languages.createDiagnosticCollection("bash");
  context.subscriptions.push(diagnostics);

  const lint = async (document: TextDocument) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (isSavedZshDocument(document)) {
      const result = await runInWorkspace(workspaceFolder, [
        "zsh",
        "-n",
        document.fileName,
      ]);
      const d = zshOutputToDiagnostics(document, result.stderr);
      diagnostics.set(document.uri, d);
    } else if (isSavedShebangShDocument(document)) {
      // if we see #!/bin/sh, it will be run by sh, not bash.
      // Check sh syntax instead - this is a common gotcha.
      const result = await runInWorkspace(workspaceFolder, [
        "sh",
        "-n",
        document.fileName,
      ]);
      const d = shOutputToDiagnostics(document, result.stderr);
      diagnostics.set(document.uri, d);
    } else if (isSavedShellDocument(document)) {
      // Compromise: assume all other shell scripts = bash.

      // e.g. file.sh will be parsed as bash.

      // This is because a lot of people have .sh files that actually
      // *are* bash, but they don't signal this accurately through file
      // extensions or shebangs.

      const result = await runInWorkspace(workspaceFolder, [
        "bash",
        "-n",
        document.fileName,
      ]);
      const d = bashOutputToDiagnostics(document, result.stderr);
      diagnostics.set(document.uri, d);
    }
  };

  vscode.workspace.onDidOpenTextDocument(lint, null, context.subscriptions);
  vscode.workspace.onDidSaveTextDocument(lint, null, context.subscriptions);
  vscode.workspace.textDocuments.forEach(lint);

  // Remove diagnostics for closed files
  vscode.workspace.onDidCloseTextDocument(
    (d) => diagnostics.delete(d.uri),
    null,
    context.subscriptions,
  );
};

/**
 * Parse bash errors from bash output for a given document.
 *
 * @param document The document to whose contents errors refer
 * @param output The error output from bash.
 * @return An array of all diagnostics
 */
const bashOutputToDiagnostics = (
  document: TextDocument,
  output: string,
): Array<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  const matches = getMatches(/^(.+): line (\d+): (.+)$/, output);
  for (const match of matches) {
    const lineNumber = Number.parseInt(match[2]);
    const message = match[3];

    const range = document.validateRange(
      new Range(lineNumber - 1, 0, lineNumber - 1, Number.MAX_VALUE),
    );
    const diagnostic = new Diagnostic(range, message);
    diagnostic.source = "bash";
    diagnostics.push(diagnostic);
  }
  return diagnostics;
};

/**
 * Parse bash errors from bash output for a given document.
 *
 * @param document The document to whose contents errors refer
 * @param output The error output from bash.
 * @return An array of all diagnostics
 */
const zshOutputToDiagnostics = (
  document: TextDocument,
  output: string,
): Array<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  // /home/brian/vscode-shell-syntax/sample.zsh:5: parse error near `fi'
  const matches = getMatches(/^(.+):(\d+): (.+)$/, output);
  for (const match of matches) {
    const lineNumber = Number.parseInt(match[2]);
    const message = match[3];

    const range = document.validateRange(
      new Range(lineNumber - 1, 0, lineNumber - 1, Number.MAX_VALUE),
    );
    const diagnostic = new Diagnostic(range, message);
    diagnostic.source = "zsh";
    diagnostics.push(diagnostic);
  }
  return diagnostics;
};

const shOutputToDiagnostics = (
  document: TextDocument,
  output: string,
): Array<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  // /home/brian/vscode-shell-syntax/sample.sh: 5: Syntax error: "fi" unexpected
  const matches = getMatches(/^(.+): (\d+): (.+)$/, output);
  for (const match of matches) {
    const lineNumber = Number.parseInt(match[2]);
    const message = match[3];

    const range = document.validateRange(
      new Range(lineNumber - 1, 0, lineNumber - 1, Number.MAX_VALUE),
    );
    const diagnostic = new Diagnostic(range, message);
    diagnostic.source = "sh";
    diagnostics.push(diagnostic);
  }
  return diagnostics;
};

/**
 * Whether a given document is saved to disk and in shell language.
 *
 * @param document The document to check
 * @return Whether the document is a shell document saved to disk
 */
const isSavedShellDocument = (document: TextDocument): boolean =>
  !document.isDirty &&
  0 <
    vscode.languages.match(
      {
        language: "shellscript",
        scheme: "file",
      },
      document,
    );

const isSavedZshDocument = (document: TextDocument): boolean => {
  if (!isSavedShellDocument(document)) {
    return false;
  }

  // .zshrc
  const extensions = [
    ".zsh",
    ".zshrc",
    ".zprofile",
    ".zlogin",
    ".zlogout",
    ".zshenv",
    ".zsh-theme",
  ];
  if (extensions.some((extension) => document.fileName.endsWith(extension))) {
    return true;
  }

  // #!/usr/bin/zsh
  const firstTextLine = document.lineAt(0);
  const textRange = new Range(
    firstTextLine.range.start,
    firstTextLine.range.end,
  );
  const firstLine = document.getText(textRange);
  if (firstLine.match(/^#!.*\b(zsh).*/)) {
    return true;
  }

  return false;
};
const isSavedShebangShDocument = (document: TextDocument): boolean => {
  if (!isSavedShellDocument(document)) {
    return false;
  }

  // #!/usr/bin/sh
  const firstTextLine = document.lineAt(0);
  const textRange = new Range(
    firstTextLine.range.start,
    firstTextLine.range.end,
  );
  const firstLine = document.getText(textRange);
  if (firstLine.match(/^#!.*\b(sh)\b.*/)) {
    return true;
  }

  return false;
};
/**
 * A system error, i.e. an error that results from a syscall.
 */
interface ISystemError extends Error {
  readonly errno: string;
}

/**
 * Whether an error is a system error.
 *
 * @param error The error to check
 */
const isSystemError = (error: Error): error is ISystemError =>
  (error as ISystemError).errno !== undefined &&
  typeof (error as ISystemError).errno === "string";

/**
 * A process error.
 *
 * A process error occurs when the process exited with a non-zero exit code.
 */
interface IProcessError extends Error {
  /**
   * The exit code of the process.
   */
  readonly code: number;
}

/**
 * Whether an error is a process error.
 */
const isProcessError = (error: Error): error is IProcessError =>
  !isSystemError(error) &&
  (error as IProcessError).code !== undefined &&
  (error as IProcessError).code > 0;

/**
 * The result of a process.
 */
interface IProcessResult {
  /**
   * The integral exit code.
   */
  readonly exitCode: number;
  /**
   * The standard output.
   */
  readonly stdout: string;
  /**
   * The standard error.
   */
  readonly stderr: string;
}

/**
 * Run a command in a given workspace folder.
 *
 * If the workspace folder is undefined run the command in the working directory
 * if the vscode instance.
 *
 * @param folder The folder to run the command in
 * @param command The command array
 * @param stdin An optional string to feed to standard input
 * @return The result of the process as promise
 */
const runInWorkspace = (
  folder: WorkspaceFolder | undefined,
  command: ReadonlyArray<string>,
  stdin?: string,
): Promise<IProcessResult> =>
  new Promise((resolve, reject) => {
    const cwd = folder ? folder.uri.fsPath : process.cwd();
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd },
      (error, stdout, stderr) => {
        if (error && !isProcessError(error)) {
          // Throw system errors, but do not fail if the command
          // fails with a non-zero exit code.
          console.error("Command error", command, error);
          reject(error);
        } else {
          const exitCode = error ? error.code : 0;
          resolve({ stdout, stderr, exitCode });
        }
      },
    );
    if (stdin && child.stdin) {
      child.stdin.end(stdin);
    }
  });

/**
 * Exec pattern against the given text and return an array of all matches.
 *
 * @param pattern The pattern to match against
 * @param text The text to match the pattern against
 * @return All matches of pattern in text.
 */
const getMatches = (
  pattern: RegExp,
  text: string,
): ReadonlyArray<RegExpMatchArray> => {
  const out: Array<RegExpMatchArray> = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      out.push(match);
    }
  }
  return out;
};
