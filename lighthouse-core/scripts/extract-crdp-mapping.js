/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileOverview Used to pull a mapping of Chrome Remote Debugging Protocol
 * event and command requests and responses for type checking of interactions.
 * See typings/protocol.d.ts for how these are used.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const crdpTypingFile = require.resolve('vscode-chrome-debug-core/lib/crdp/crdp.d.ts');
const lhCrdpExternsOutputFile = path.resolve(__dirname, '../../typings/crdp-mapping.d.ts');

/* eslint-disable max-len */
const headerBlock = `/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

// Generated by \`yarn update:crdp-typings\`
`;
/* eslint-enable max-len */

const OUTPUT_EVENTS_NAME = 'CrdpEvents';
const OUTPUT_COMMANDS_NAME = 'CrdpCommands';

/**
 * DFS of AST, returning the first interface or module found with matching
 * target name.
 * @param {ts.Node} rootNode
 * @param {string} targetName
 * @return {ts.Node|undefined}
 */
function findFirstInterfaceOrModule(rootNode, targetName) {
  /**
   * @param {ts.Node} node
   * @return {ts.Node|undefined}
   */
  function walker(node) {
    if (ts.isInterfaceDeclaration(node)) {
      if (node.name.escapedText === targetName) {
        return node;
      }
    }
    if (ts.isModuleDeclaration(node)) {
      if (node.name.text === targetName) {
        return node;
      }
    }

    return ts.forEachChild(node, walker);
  }

  return walker(rootNode);
}

/**
 * Expects to start at root node.
 * @param {ts.Node} node
 * @return {Array<string>}
 */
function getCrdpDomainNames(node) {
  const crdpClientInterface = findFirstInterfaceOrModule(node, 'CrdpClient');
  if (!crdpClientInterface) {
    throw new Error('no `interface CrdpClient` found in typing file');
  }

  /** @type {Array<string>} */
  const domainProperties = [];
  ts.forEachChild(crdpClientInterface, node => {
    if (ts.isPropertySignature(node)) {
      if (ts.isIdentifier(node.name)) {
        domainProperties.push(node.name.text);
      }
    }
  });

  return domainProperties;
}

/**
 * Returns the qualified name of the type node.
 * @param {ts.TypeReferenceNode} typeNode
 * @param {string} debugName A name to print for type if error is found.
 * @return {{domain: string, type: string}}
 */
function getTypeName(typeNode, debugName) {
  if (ts.isQualifiedName(typeNode.typeName)) {
    if (ts.isQualifiedName(typeNode.typeName.left)) {
      throw new Error(`unsupported triple nested type name in ${debugName}`);
    }
    const domain = typeNode.typeName.left.text;
    const type = typeNode.typeName.right.text;

    return {domain, type};
  }

  throw new Error(`unexpected type node in ${debugName}`);
}

/**
 * Asserts that this is a function that has zero or one parameters and returns
 * null or the parameter's type, respectively.
 * @param {ts.FunctionTypeNode} functionNode
 * @param {string} debugName A name to print for function if error is found.
 * @return {?ts.TypeReferenceNode}
 */
function getParamType(functionNode, debugName) {
  const paramCount = functionNode.parameters.length;

  if (paramCount === 1) {
    const paramType = functionNode.parameters[0].type;
    if (paramType && ts.isTypeReferenceNode(paramType)) {
      return paramType;
    }

    throw new Error(`unexpected param passed to ${debugName}`);
  } else if (paramCount > 1) {
    throw new Error(`found ${paramCount} parameters passed to ${debugName}.`);
  }

  return null;
}

/**
 * Validates that this is an event listener we're expecting and returns the
 * type of its expected payload (or null if none expected).
 * @param {ts.MethodSignature} methodNode
 * @param {string} methodName
 * @return {?ts.TypeReferenceNode}
 */
function getEventListenerParamType(methodNode, methodName) {
  if (methodNode.parameters.length > 1) {
    throw new Error(`found ${methodNode.parameters.length} parameters passed to ${methodName}.`);
  }
  const listenerTypeNode = methodNode.parameters[0].type;
  if (!listenerTypeNode || !ts.isFunctionTypeNode(listenerTypeNode)) {
    throw new Error(`found unexpected argument passed to ${methodName}.`);
  }

  return getParamType(listenerTypeNode, methodName);
}

/**
 * Returns a Map of events for given domain
 * @param {ts.Node} sourceRoot
 * @param {string} domainName
 * @return {Map<string, string>}
 */
function getEventMap(sourceRoot, domainName) {
  // We want 'DomainNameClient' interface, sibling to domain module, for event info.
  const eventInterfaceName = domainName + 'Client';
  const eventInterface = findFirstInterfaceOrModule(sourceRoot, eventInterfaceName);

  if (!eventInterface || !ts.isInterfaceDeclaration(eventInterface)) {
    throw new Error(`Events interface not found for domain '${domainName}'.`);
  }

  /** @type {Map<string, string>} */
  const eventMap = new Map();

  for (const member of eventInterface.members) {
    if (!ts.isMethodSignature(member)) {
      continue;
    }

    if (!ts.isIdentifier(member.name)) {
      throw new Error('Bad event method found' + member);
    }
    const methodName = member.name.text;
    if (!/^on[A-Z]/.test(methodName)) {
      throw new Error('bad method name found: ' + methodName);
    }
    const eventString = methodName[2].toLowerCase() + methodName.slice(3);
    const eventName = `${domainName}.${eventString}`;

    const rawEventType = getEventListenerParamType(member, methodName);
    let eventType = 'void';
    if (rawEventType !== null) {
      const {domain, type} = getTypeName(rawEventType, methodName);
      eventType = `Crdp.${domain}.${type}`;
    }

    eventMap.set(eventName, eventType);
  }

  return eventMap;
}

/**
 * Asserts that this is a function returning a promised value and returns the
 * type of that value.
 * @param {ts.FunctionTypeNode} functionNode
 * @param {string} debugName A name to print for function if error is found.
 * @return {string}
 */
function getPromisedReturnType(functionNode, debugName) {
  const returnTypeNode = functionNode.type;
  if (returnTypeNode && ts.isTypeReferenceNode(returnTypeNode)) {
    // Check returning a promise.
    if (!ts.isIdentifier(returnTypeNode.typeName) ||
        returnTypeNode.typeName.text !== 'Promise' ||
        !returnTypeNode.typeArguments) {
      throw new Error(`command ${debugName} has unexpected return type`);
    }

    // Get promise's payload
    if (returnTypeNode.typeArguments.length !== 1) {
      throw new Error(`unexpected param(s) passed to ${debugName}`);
    }

    const payloadType = returnTypeNode.typeArguments[0];

    if (payloadType.kind === ts.SyntaxKind.VoidKeyword) {
      return 'void';
    } else if (ts.isTypeReferenceNode(payloadType)) {
      const {domain, type} = getTypeName(payloadType, debugName);
      return `${domain}.${type}`;
    }
  }

  throw new Error(`unexpected return type for ${debugName}`);
}

/**
 * Returns true if all properties on interface are optional. Does simple search
 * for interface declaration, assuming top level domain name and interface
 * defined at the top level within.
 * @param {ts.Node} sourceRoot
 * @param {string} domainName
 * @param {string} interfaceName
 * @return {boolean}
 */
function isWeakInterface(sourceRoot, domainName, interfaceName) {
  const domainInterface = findFirstInterfaceOrModule(sourceRoot, domainName);
  if (!domainInterface || !ts.isModuleDeclaration(domainInterface)) {
    throw new Error(`domain ${domainName} not found`);
  }
  const targetInterface = findFirstInterfaceOrModule(domainInterface, interfaceName);
  if (!targetInterface || !ts.isInterfaceDeclaration(targetInterface)) {
    throw new Error(`interface ${interfaceName} not found within ${domainName} domain`);
  }

  return targetInterface.members.every(member => {
    if (!ts.isPropertySignature(member)) {
      return true;
    }

    return member.questionToken !== undefined;
  });
}

/**
 * Returns a Map of events to params and return type for given domain.
 * @param {ts.Node} sourceRoot
 * @param {string} domainName
 * @return {Map<string, {paramsType: string, returnType: string}>}
 */
function getCommandMap(sourceRoot, domainName) {
  // We want 'DomainNameCommands' interface, sibling to domain module, for event info.
  const commandInterfaceName = domainName + 'Commands';
  const commandInterface = findFirstInterfaceOrModule(sourceRoot, commandInterfaceName);

  if (!commandInterface || !ts.isInterfaceDeclaration(commandInterface)) {
    throw new Error(`Command interface not found for domain '${domainName}'.`);
  }

  /** @type {Map<string, {paramsType: string, returnType: string}>} */
  const commandMap = new Map();

  for (const member of commandInterface.members) {
    if (!ts.isPropertySignature(member)) {
      continue;
    }

    if (!ts.isIdentifier(member.name) ) {
      throw new Error('Bad event method found ' + member);
    }
    const commandName = `${domainName}.${member.name.text}`;

    const commandFn = member.type;
    if (!commandFn || !ts.isFunctionTypeNode(commandFn)) {
      throw new Error(`Command ${commandName} did not have an assigned function`);
    }

    const rawParamsTypeNode = getParamType(commandFn, commandName);
    let paramsType = 'void';
    if (rawParamsTypeNode !== null) {
      const {domain, type} = getTypeName(rawParamsTypeNode, commandName);
      paramsType = `Crdp.${domain}.${type}`;

      // if paramsType is entirely optional methods, allow void so it can be
      // called without params
      if (isWeakInterface(sourceRoot, domain, type)) {
        paramsType = 'void | ' + paramsType;
      }
    }

    const rawReturnTypeName = getPromisedReturnType(commandFn, commandName);
    const returnType = rawReturnTypeName === 'void' ? 'void' :
        `Crdp.${rawReturnTypeName}`;

    commandMap.set(commandName, {paramsType, returnType});
  }

  return commandMap;
}

/**
 * @param {number} indentLevel
 */
function newline(indentLevel) {
  return '\n' + '  '.repeat(indentLevel);
}

/**
 * Append map of all events to outputStr, properly indented.
 * @param {ts.Node} sourceRoot
 * @param {Array<string>} domainNames
 * @param {number} indentLevel
 * @return {string}
 */
function outputEventMap(sourceRoot, domainNames, indentLevel) {
  let outputStr = newline(indentLevel) + `export interface ${OUTPUT_EVENTS_NAME} {`;

  for (const domainName of domainNames) {
    const eventMap = getEventMap(sourceRoot, domainName);
    for (const [eventName, eventType] of eventMap) {
      outputStr += newline(indentLevel + 1) + `'${eventName}': ${eventType};`;
    }
  }

  outputStr += newline(indentLevel) + '}';

  return outputStr;
}

/**
 * Append map of all comand params/return types to outputStr, properly indented.
 * @param {ts.Node} sourceRoot
 * @param {Array<string>} domainNames
 * @param {number} indentLevel
 * @return {string}
 */
function outputCommandMap(sourceRoot, domainNames, indentLevel) {
  let outputStr = newline(indentLevel) + `export interface ${OUTPUT_COMMANDS_NAME} {`;

  for (const domainName of domainNames) {
    const commandsMap = getCommandMap(sourceRoot, domainName);
    for (const [commandName, {paramsType, returnType}] of commandsMap) {
      outputStr += newline(indentLevel + 1) + `'${commandName}': {`;
      outputStr += newline(indentLevel + 2) + `paramsType: ${paramsType},`;
      outputStr += newline(indentLevel + 2) + `returnType: ${returnType}`;
      outputStr += newline(indentLevel + 1) + '};';
    }
  }

  outputStr += newline(indentLevel) + '}';

  return outputStr;
}

const source = fs.readFileSync(crdpTypingFile, 'utf8');
const sourceRoot = ts.createSourceFile(crdpTypingFile, source, ts.ScriptTarget.ES2017, false);
const crdpDomainNames = getCrdpDomainNames(sourceRoot);

let crdpStr = headerBlock;
crdpStr += `
declare global {
  module LH {`;

crdpStr += outputEventMap(sourceRoot, crdpDomainNames, 2);
crdpStr += '\n';
crdpStr += outputCommandMap(sourceRoot, crdpDomainNames, 2);

crdpStr += `
  }
}

// empty export to keep file a module
export {}
`;

// eslint-disable-next-line no-console
console.log('crdp mappings generated');
fs.writeFileSync(lhCrdpExternsOutputFile, crdpStr);
