import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(exec);

/**
 * Validates infrastructure manifests (Kubernetes YAML, Terraform) using
 * dry-run against the target API.
 */
export interface SandboxResult {
  valid: boolean;
  output: string;
}

export class ExecutionSandbox {
  private static async writeTempFile(content: string, extension: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "neurofebric-sandbox-"));
    const filePath = join(tempDir, `manifest${extension}`);
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  /**
   * Validates a Kubernetes manifest using kubectl dry-run.
   * Requires kubectl to be available and configured with a target cluster.
   */
  private static async validateKubernetes(yamlContent: string): Promise<SandboxResult> {
    const tempFile = await this.writeTempFile(yamlContent, ".yaml");
    try {
      // --dry-run=server validates against the API server without applying
      const { stdout, stderr } = await execAsync(
        `kubectl apply -f "${tempFile}" --dry-run=server`,
        { timeout: 30000 }
      );
      return { valid: true, output: stdout || stderr };
    } catch (error: any) {
      // kubectl returns non-zero exit code on validation failure
      return {
        valid: false,
        output: error.stderr || error.stdout || error.message,
      };
    } finally {
      // Cleanup temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Validates a Terraform configuration using terraform validate.
   * Requires terraform to be available.
   */
  private static async validateTerraform(tfContent: string): Promise<SandboxResult> {
    const tempFile = await this.writeTempFile(tfContent, ".tf");
    try {
      // terraform validate requires a directory with .tf files
      const { stdout, stderr } = await execAsync(
        `terraform validate`,
        { cwd: tempFile.replace(".tf", ""), timeout: 30000 }
      );
      return { valid: true, output: stdout || stderr };
    } catch (error: any) {
      return {
        valid: false,
        output: error.stderr || error.stdout || error.message,
      };
    } finally {
      // Cleanup temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Validates a manifest string against the appropriate infrastructure tooling.
   * @param yamlContent The raw YAML or Terraform content
   * @param format 'kubernetes' | 'terraform'
   * @returns SandboxResult with validity and output/error message
   */
  static async validateManifest(
    yamlContent: string,
    format: "kubernetes" | "terraform"
  ): Promise<SandboxResult> {
    if (!yamlContent.trim()) {
      return { valid: false, output: "Empty manifest content" };
    }

    switch (format) {
      case "kubernetes":
        return this.validateKubernetes(yamlContent);
      case "terraform":
        return this.validateTerraform(yamlContent);
      default:
        return { valid: false, output: `Unknown format: ${format}` };
    }
  }
}