/**
 * fldigi-macro-syntax: VS Code integration layer.
 *
 * All the real logic lives in mdf-analyzer.js, which has no vscode dependency
 * and can be tested with plain node. This file only adapts its output to the
 * editor and manages the diagnostic lifecycle.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./mdf-analyzer');

const LANGUAGE_ID = 'fldigi-mdf';
const SOURCE = 'fldigi-mdf';

/** @type {import('./mdf-analyzer').TagData|null} */
let tagData = null;

/**
 * Load the generated tag tables that ship with the extension.
 * Produced by tools/gen_grammar.py from fldigi's own source.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {import('./mdf-analyzer').TagData|null}
 */
function loadTagData(context) {
  const file = path.join(context.extensionPath, 'data', 'fldigi-tags.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(
      `fldigi-macro-syntax: could not read ${file}. ` +
        `Diagnostics are disabled. Run "make grammar" to regenerate it. (${err})`
    );
    return null;
  }
}

/** @type {Record<string, vscode.DiagnosticSeverity>} */
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/**
 * @param {vscode.TextDocument} doc
 * @param {vscode.DiagnosticCollection} collection
 */
function refresh(doc, collection) {
  if (doc.languageId !== LANGUAGE_ID) return;
  if (!tagData) return;

  let findings;
  try {
    findings = analyze(doc.getText(), tagData);
  } catch (err) {
    // A analyzer bug must never break the editor experience.
    console.error('fldigi-macro-syntax: analyzer threw', err);
    collection.delete(doc.uri);
    return;
  }

  const diagnostics = findings.map((f) => {
    const range = new vscode.Range(f.line, f.startCol, f.line, f.endCol);
    const d = new vscode.Diagnostic(range, f.message, SEVERITY[f.severity]);
    d.source = SOURCE;
    d.code = f.code;
    return d;
  });

  collection.set(doc.uri, diagnostics);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  tagData = loadTagData(context);

  const collection = vscode.languages.createDiagnosticCollection(SOURCE);
  context.subscriptions.push(collection);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document, collection)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  // Documents already open when the extension activates.
  vscode.workspace.textDocuments.forEach((doc) => refresh(doc, collection));
}

function deactivate() {}

module.exports = { activate, deactivate };