/**
 * Setup to Doctor to Profile - E2E Integration Test (Parametrized)
 *
 * Tests the complete user flow with REAL HTTP connections for multiple providers:
 * 1. Setup a profile from environment variables
 * 2. Run doctor health checks (makes actual HTTP requests)
 * 3. Verify profile status
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *
 * For LiteLLM:
 * - LITELLM_BASE_URL: LiteLLM server URL (e.g., http://localhost:4000)
 * - LITELLM_API_KEY: LiteLLM API key
 * - LITELLM_MODEL: Model to test (e.g., gpt-4o)
 *
 * For Bedrock:
 * - BEDROCK_BASE_URL: Bedrock runtime URL (e.g., https://bedrock-runtime.us-east-1.amazonaws.com)
 * - BEDROCK_API_KEY: AWS Access Key ID
 * - BEDROCK_SECRET_KEY: AWS Secret Access Key
 * - BEDROCK_REGION: AWS region (e.g., us-east-1)
 * - BEDROCK_MODEL: Model to test (e.g., claude-sonnet-4-5)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { createCLIRunner, type CommandResult } from '../helpers/index.js';
import type { MultiProviderConfig, CodeMieConfigOptions } from '../../src/env/types.js';

// Test data structure for each provider
interface ProviderTestData {
  name: string;
  profileName: string;
  envVars: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    secretKey?: string;
    region?: string;
  };
  buildProfile: (data: ProviderTestData) => CodeMieConfigOptions;
}

// Define test cases for each provider
const providerTestCases: ProviderTestData[] = [
  {
    name: 'LiteLLM',
    profileName: 'litellm',
    envVars: {
      baseUrl: process.env.LITELLM_BASE_URL,
      apiKey: process.env.LITELLM_API_KEY,
      model: process.env.LITELLM_MODEL
    },
    buildProfile: (data) => ({
      provider: 'litellm',
      baseUrl: data.envVars.baseUrl!,
      apiKey: data.envVars.apiKey!,
      model: data.envVars.model,
      timeout: 300
    })
  },
  {
    name: 'Bedrock',
    profileName: 'bedrock',
    envVars: {
      baseUrl: process.env.BEDROCK_BASE_URL,
      apiKey: process.env.BEDROCK_API_KEY,
      secretKey: process.env.BEDROCK_SECRET_KEY,
      region: process.env.BEDROCK_REGION,
      model: process.env.BEDROCK_MODEL
    },
    buildProfile: (data) => ({
      provider: 'bedrock',
      baseUrl: data.envVars.baseUrl!,
      apiKey: data.envVars.apiKey!,
      awsSecretAccessKey: data.envVars.secretKey!,
      awsRegion: data.envVars.region!,
      model: data.envVars.model,
      timeout: 300,
      debug: false,
      name: data.profileName
    })
  }
];

describe('Setup profile - run codemie doctor - run codemie profile', () => {
  const cli = createCLIRunner();
  let testConfigDir: string;
  let testConfigFile: string;

  beforeEach(async () => {
    // Setup paths
    testConfigDir = join(homedir(), '.codemie');
    testConfigFile = join(testConfigDir, 'config.json');

    // Ensure directory exists
    await mkdir(testConfigDir, { recursive: true });

    // Clear config file before test (start with clean slate)
    if (existsSync(testConfigFile)) {
      await rm(testConfigFile);
    }
  });

  // Run parametrized tests for each provider
  providerTestCases.forEach((testCase) => {
    it(`should setup ${testCase.name} profile, run doctor with real connection, and check profile status`, async () => {
      // Skip test if required credentials not provided
      const requiredVars = ['baseUrl', 'apiKey'];
      if (testCase.profileName === 'bedrock') {
        requiredVars.push('secretKey', 'region');
      }

      const missingVars = requiredVars.filter(key => !testCase.envVars[key as keyof typeof testCase.envVars]);
      if (missingVars.length > 0) {
        console.log(`⏭️  Skipping ${testCase.name} e2e test: Missing environment variables: ${missingVars.join(', ')}`);
        return;
      }

      // Step 1: Create profile from environment variables
      const profileConfig = testCase.buildProfile(testCase);
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile: testCase.profileName,
        profiles: {
          [testCase.profileName]: profileConfig
        }
      };

      await writeFile(testConfigFile, JSON.stringify(config, null, 2));

      // Verify config was created
      expect(existsSync(testConfigFile)).toBe(true);
      const writtenConfig = JSON.parse(await readFile(testConfigFile, 'utf-8'));
      expect(writtenConfig.version).toBe(2);
      expect(writtenConfig.activeProfile).toBe(testCase.profileName);
      expect(writtenConfig.profiles[testCase.profileName].provider).toBe(testCase.profileName);
      expect(writtenConfig.profiles[testCase.profileName].baseUrl).toBe(testCase.envVars.baseUrl);

      // Step 2: Run 'codemie doctor'
      const doctorResult: CommandResult = cli.runSilent('doctor');

      // Verify health check header
      expect(doctorResult.output).toMatch(/CodeMie Code Health Check/i);

      // Verify system dependencies sections
      expect(doctorResult.output).toMatch(/Node\.js:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*v\d+/); // Node.js version

      expect(doctorResult.output).toMatch(/npm:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*\d+/); // npm version

      expect(doctorResult.output).toMatch(/Python:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*\d+/); // Python version

      expect(doctorResult.output).toMatch(/uv:/i);
      expect(doctorResult.output).toMatch(/✓.*Version/); // uv version

      expect(doctorResult.output).toMatch(/AWS CLI:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*aws-cli/); // AWS CLI version

      // Verify Active Profile section with exact format
      expect(doctorResult.output).toMatch(/Active Profile:/i);
      expect(doctorResult.output).toContain(`○ Active Profile: ${testCase.profileName}`);
      expect(doctorResult.output).toContain(`✓ Provider: ${testCase.profileName}`);
      expect(doctorResult.output).toContain(`✓ Base URL: ${testCase.envVars.baseUrl}`);

      // Verify model if provided
      if (testCase.envVars.model) {
        expect(doctorResult.output).toContain(`✓ Model: ${testCase.envVars.model}`);
      }

      // Verify Installed Agents section
      expect(doctorResult.output).toMatch(/Installed Agents:/i);
      expect(doctorResult.output).toMatch(/✓.*CodeMie Native/i);
      expect(doctorResult.output).toMatch(/.*Claude Code/i);
      expect(doctorResult.output).toMatch(/.*Codex/i);
      expect(doctorResult.output).toMatch(/.*Gemini CLI/i);

      // Verify Repository & Workflows section
      expect(doctorResult.output).toMatch(/Repository & Workflows:/i);

      // Verify final status message
      expect(doctorResult.output).toMatch(/✓.*All checks passed!/i);

      // Step 3: Run 'codemie profile' (default action shows status)
      const profileResult: CommandResult = cli.runSilent('profile');

      // Verify exit code
      expect(profileResult.exitCode).toBe(0);

      // Verify profile list format
      expect(profileResult.output).toContain('All Profiles:');
      expect(profileResult.output).toMatch(new RegExp(`Profile\\s+│\\s+${testCase.profileName}\\s+\\(Active\\)`));
      expect(profileResult.output).toMatch(new RegExp(`Provider\\s+│\\s+${testCase.profileName}`));

      // Verify model if provided
      if (testCase.envVars.model) {
        expect(profileResult.output).toMatch(new RegExp(`Model\\s+│\\s+${testCase.envVars.model}`));
      }

      // Verify separator line
      expect(profileResult.output).toMatch(/─{40,}/);

      // Verify Next Steps section
      expect(profileResult.output).toContain('Next Steps:');
      expect(profileResult.output).toContain('codemie profile switch');
      expect(profileResult.output).toContain('codemie profile status');
      expect(profileResult.output).toContain('codemie setup');
      expect(profileResult.output).toContain('codemie profile delete');
    });
  });
});
