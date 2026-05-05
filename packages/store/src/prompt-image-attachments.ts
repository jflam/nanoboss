import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
} from "@nanoboss/contracts";

const STALE_ATTACHMENT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class PromptImageAttachmentStore {
  private readonly attachmentsDir: string;
  private readonly pendingAttachmentStages = new Map<string, { tempPath: string; refCount: number }>();

  constructor(private readonly rootDir: string) {
    this.attachmentsDir = join(rootDir, "attachments");
  }

  persistPromptImages(input: PromptInput): PromptImageSummary[] | undefined {
    const images = input.parts.filter((part): part is PromptImagePart => part.type === "image");
    if (images.length === 0) {
      return undefined;
    }

    mkdirSync(this.attachmentsDir, { recursive: true });
    return images.map((image) => this.persistPromptImage(image));
  }

  discardPendingPromptImages(promptImages: PromptImageSummary[] | undefined): void {
    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        this.pendingAttachmentStages.delete(attachmentPath);
        continue;
      }

      const stage = this.pendingAttachmentStages.get(attachmentPath);
      if (!stage || !existsSync(stage.tempPath)) {
        continue;
      }

      stage.refCount -= 1;
      if (stage.refCount <= 0) {
        unlinkSync(stage.tempPath);
        this.pendingAttachmentStages.delete(attachmentPath);
      }
    }
  }

  promotePersistedPromptImages(promptImages: PromptImageSummary[] | undefined): void {
    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        continue;
      }

      const tempPath = buildAttachmentTempPath(filePath);
      if (existsSync(tempPath)) {
        renameSync(tempPath, filePath);
      }
    }
  }

  promotePendingPromptImages(promptImages: PromptImageSummary[] | undefined): void {
    const promotions = new Map<string, { attachmentPath: string; filePath: string; tempPath: string }>();

    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        this.pendingAttachmentStages.delete(attachmentPath);
        continue;
      }

      const tempPath = buildAttachmentTempPath(filePath);
      if (!existsSync(tempPath)) {
        throw new Error(`Missing staged prompt image attachment: ${attachmentPath}`);
      }

      promotions.set(attachmentPath, { attachmentPath, filePath, tempPath });
    }

    const uniquePromotions = [...promotions.values()];
    const promoted = new Map<string, { attachmentPath: string; filePath: string; tempPath: string }>();
    try {
      for (const promotion of uniquePromotions) {
        renameSync(promotion.tempPath, promotion.filePath);
        promoted.set(promotion.attachmentPath, promotion);
      }
    } catch (error) {
      const promotedEntries = [...promoted.values()];
      for (let index = promotedEntries.length - 1; index >= 0; index -= 1) {
        const promotion = promotedEntries[index];
        if (promotion && existsSync(promotion.filePath) && !existsSync(promotion.tempPath)) {
          renameSync(promotion.filePath, promotion.tempPath);
        }
      }
      throw error;
    }

    for (const promotion of uniquePromotions) {
      this.pendingAttachmentStages.delete(promotion.attachmentPath);
    }
  }

  cleanupStaleAttachmentTemps(now = Date.now()): void {
    if (!existsSync(this.attachmentsDir)) {
      return;
    }

    for (const entry of readdirSync(this.attachmentsDir)) {
      if (!entry.endsWith(".tmp")) {
        continue;
      }

      const path = join(this.attachmentsDir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }

      if (now - stats.mtimeMs <= STALE_ATTACHMENT_TEMP_MAX_AGE_MS) {
        continue;
      }

      unlinkSync(path);
    }
  }

  private persistPromptImage(image: PromptImagePart): PromptImageSummary {
    const bytes = Buffer.from(image.data, "base64");
    const digest = createHash("sha256")
      .update(image.mimeType)
      .update("\0")
      .update(bytes)
      .digest("hex");
    const extension = fileExtensionForMimeType(image.mimeType);
    const attachmentId = extension ? `${digest}.${extension}` : digest;
    const attachmentPath = `attachments/${attachmentId}`;
    const filePath = join(this.rootDir, attachmentPath);
    const tempPath = buildAttachmentTempPath(filePath);
    const pendingStage = this.pendingAttachmentStages.get(attachmentPath);

    if (!existsSync(filePath)) {
      if (pendingStage && existsSync(pendingStage.tempPath)) {
        pendingStage.refCount += 1;
      } else if (existsSync(tempPath)) {
        this.pendingAttachmentStages.set(attachmentPath, {
          tempPath,
          refCount: 1,
        });
      } else {
        writeFileSync(tempPath, bytes);
        this.pendingAttachmentStages.set(attachmentPath, {
          tempPath,
          refCount: 1,
        });
      }
    }

    return {
      token: image.token,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      byteLength: image.byteLength,
      attachmentId,
      attachmentPath,
    };
  }
}

function fileExtensionForMimeType(mimeType: string): string | undefined {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return undefined;
  }
}

function buildAttachmentTempPath(path: string): string {
  return `${path}.tmp`;
}
