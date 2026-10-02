#!/usr/bin/env node
/**
 * Validates that the tools listed in manifest.template.json match
 * the tools actually provided by the running MCP server
 * 
 * This uses JSON-RPC to query the server directly, avoiding fragile regex parsing.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

async function extractToolsFromManifest() {
  // The generated MCPB bundle is gitignored. Validate against the tracked
  // source manifest so a fresh checkout can run this gate without first
  // generating packaging artifacts.
  const manifestPath = join(rootDir, 'manifest.template.json');
  const content = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(content);
  
  return manifest.tools.map(tool => tool.name).sort();
}

async function extractToolsFromServer() {
  return new Promise((resolve, reject) => {
    // Start the MCP server
    const serverPath = join(rootDir, 'dist', 'index.js');
    const server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';
    const messages = [];
    let toolsRequested = false;
    let settled = false;
    let deadline;

    const finishReject = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      server.kill();
      reject(new Error(`${message}${errorOutput.trim() ? `\nServer stderr:\n${errorOutput.trim()}` : ''}`));
    };

    const maybeHandleMessage = (message) => {
      if (!toolsRequested && message.id === 1 && message.result) {
        toolsRequested = true;
        // MCP requires the initialized notification after initialize completes.
        server.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {}
        }) + '\n');
        server.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        }) + '\n');
      }

      if (message.id === 2 && message.result?.tools) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        server.kill();
        resolve(message.result.tools.map(tool => tool.name).sort());
      } else if (message.id === 2 && message.error) {
        finishReject(`tools/list failed: ${message.error.message ?? JSON.stringify(message.error)}`);
      }
    };

    server.stdout.on('data', (data) => {
      output += data.toString();
      
      // Try to parse each line as JSON-RPC message
      const lines = output.split('\n');
      output = lines.pop() || ''; // Keep incomplete line
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            messages.push(message);
            maybeHandleMessage(message);
          } catch (e) {
            // Not JSON, might be debug output
          }
        }
      }
    });

    server.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Step 1: Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'validate-tools-sync',
          version: '1.0.0'
        }
      }
    };

    server.stdin.write(JSON.stringify(initRequest) + '\n');

    deadline = setTimeout(() => {
      finishReject(`No tools/list response received within 5s (messages=${messages.length})`);
    }, 5000);

    server.on('error', (error) => {
      finishReject(`Failed to start server: ${error.message}`);
    });
  });
}

async function main() {
  console.log(`${colors.cyan}🔍 Validating tool synchronization...${colors.reset}\n`);
  
  try {
    const manifestTools = await extractToolsFromManifest();
    const serverTools = await extractToolsFromServer();
    
    console.log(`${colors.blue}📋 Manifest tools (${manifestTools.length}):${colors.reset}`);
    manifestTools.forEach(tool => console.log(`   - ${tool}`));
    
    console.log(`\n${colors.blue}⚙️  Server tools (${serverTools.length}):${colors.reset}`);
    serverTools.forEach(tool => console.log(`   - ${tool}`));
    
    // Find differences
    const missingInManifest = serverTools.filter(t => !manifestTools.includes(t));
    const missingInServer = manifestTools.filter(t => !serverTools.includes(t));
    
    console.log('\n' + '='.repeat(60));
    
    if (missingInManifest.length === 0 && missingInServer.length === 0) {
      console.log(`${colors.green}✅ SUCCESS: All tools are in sync!${colors.reset}`);
      console.log(`${colors.green}   Both manifest.template.json and server.ts have ${manifestTools.length} tools.${colors.reset}`);
      process.exit(0);
    } else {
      console.log(`${colors.red}❌ MISMATCH DETECTED!${colors.reset}\n`);
      
      if (missingInManifest.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in server.ts but NOT in manifest.template.json:${colors.reset}`);
        missingInManifest.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      if (missingInServer.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in manifest.template.json but NOT in server.ts:${colors.reset}`);
        missingInServer.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      console.log(`${colors.red}Please update the files to match!${colors.reset}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`${colors.red}❌ Error:${colors.reset}`, error.message);
    process.exit(1);
  }
}

main();
