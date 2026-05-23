/**
 * PUSH NOTIFICATION SERVICE
 * =========================
 *
 * Handles push notifications via OneSignal for:
 * - Banner notifications (Claude response complete)
 * - Silent badge updates (in_progress task count)
 *
 * Uses OneSignal's external_id feature to link iOS devices to backend user IDs.
 */

import * as OneSignal from '@onesignal/node-onesignal';
import { getAllTasks } from './taskService.js';

// OneSignal client singleton
let client: OneSignal.DefaultApi | null = null;
let clientAppId: string | null = null;

interface OneSignalConfig {
  appId: string | undefined;
  restApiKey: string | undefined;
}

/**
 * Get OneSignal configuration from environment
 * Read at runtime to ensure .env is loaded first
 */
function getConfig(): OneSignalConfig {
  return {
    appId: process.env.ONESIGNAL_APP_ID,
    restApiKey: process.env.ONESIGNAL_REST_API_KEY,
  };
}

/**
 * Get or create the OneSignal client
 */
function getClient(): OneSignal.DefaultApi | null {
  const { appId, restApiKey } = getConfig();

  if (!client && appId && restApiKey) {
    const configuration = OneSignal.createConfiguration({
      restApiKey,
    });
    client = new OneSignal.DefaultApi(configuration);
    clientAppId = appId;
    console.log('[OneSignal] Client initialized with app:', appId);
  }
  return client;
}

/**
 * Get the app ID for notifications
 */
function getAppId(): string | undefined {
  if (clientAppId) return clientAppId;
  return getConfig().appId;
}

/**
 * Check if OneSignal is configured
 */
function isConfigured(): boolean {
  const { appId, restApiKey } = getConfig();
  return !!(appId && restApiKey);
}

/**
 * Convert backend user ID to OneSignal external_id format
 * Uses "user_" prefix to avoid OneSignal blocking simple IDs like "1"
 */
function toExternalId(userId: string | number): string {
  return `user_${userId}`;
}

interface NotificationData {
  type?: string;
  taskId?: string | null;
  conversationId?: string;
  projectId?: string | null;
  deepLink?: string | null;
  [key: string]: unknown;
}

/**
 * Send a banner notification when Claude completes a response
 */
async function sendBannerNotification(
  userId: string | number,
  title: string,
  message: string,
  data: NotificationData = {},
): Promise<unknown | null> {
  const onesignalClient = getClient();

  if (!onesignalClient) {
    console.log('[OneSignal] Not configured, skipping banner notification');
    return null;
  }

  try {
    const notification = new OneSignal.Notification();
    notification.app_id = getAppId() as string;
    notification.headings = { en: title };
    notification.contents = { en: message };
    notification.include_aliases = {
      external_id: [toExternalId(userId)],
    };
    notification.target_channel = 'push';
    notification.data = data;

    // iOS-specific settings for visible notification
    notification.ios_sound = 'default';
    notification.ios_interruption_level = 'active';

    const response = await onesignalClient.createNotification(notification);
    console.log(
      `[OneSignal] Banner notification sent to user ${userId}: id=${(response as { id?: string }).id}, projectId=${data.projectId}, taskId=${data.taskId}, conversationId=${data.conversationId}, deepLink=${data.deepLink}`,
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[OneSignal] Failed to send banner notification:', message);
    return null;
  }
}

/**
 * Send a silent notification to update badge count
 * Uses content_available for iOS background processing
 */
async function sendBadgeUpdate(
  userId: string | number,
  badgeCount: number,
): Promise<unknown | null> {
  const onesignalClient = getClient();

  if (!onesignalClient) {
    console.log('[OneSignal] Not configured, skipping badge update');
    return null;
  }

  console.log(`[OneSignal] Sending silent badge update to user ${userId}: count=${badgeCount}`);

  try {
    const notification = new OneSignal.Notification();
    notification.app_id = getAppId() as string;
    notification.include_aliases = {
      external_id: [toExternalId(userId)],
    };
    notification.target_channel = 'push';

    // Silent notification (content-available for iOS background processing)
    notification.content_available = true;

    // Badge settings - set to exact count (snake_case for SDK)
    notification.ios_badge_type = 'SetTo';
    notification.ios_badge_count = badgeCount;

    // Empty content for silent push
    notification.contents = { en: '' };

    const response = await onesignalClient.createNotification(notification);
    console.log(
      `[OneSignal] Badge update sent to user ${userId}: count=${badgeCount}, id=${(response as { id?: string }).id}`,
    );
    return response;
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error('[OneSignal] Failed to send badge update:', errMessage);
    const body = (error as { body?: unknown }).body;
    if (body) {
      console.error('[OneSignal] Error details:', JSON.stringify(body, null, 2));
    }
    return null;
  }
}

/**
 * Get count of in_progress tasks for a user
 */
function getInProgressTaskCount(userId: number): number {
  try {
    const tasks = getAllTasks(userId, 'in_progress');
    return tasks.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[OneSignal] Failed to get in_progress task count:', message);
    return 0;
  }
}

/**
 * Update badge for a user based on their current in_progress tasks count
 */
async function updateUserBadge(userId: number): Promise<unknown | null> {
  const count = getInProgressTaskCount(userId);
  return sendBadgeUpdate(userId, count);
}

export interface NotifyClaudeCompleteOptions {
  agentType?: string | null;
  workflowComplete?: boolean;
}

/**
 * Send notification when Claude finishes responding
 */
async function notifyClaudeComplete(
  userId: number,
  taskTitle: string | null,
  taskId: number,
  conversationId: number,
  projectId: number | null,
  options: NotifyClaudeCompleteOptions = {},
): Promise<unknown | null> {
  const { agentType = null, workflowComplete = false } = options;

  // Determine if we should send notification
  // 1. User-initiated conversations (no agent) - always notify
  // 2. Planification agent - notify (user needs to review/approve plan)
  // 3. PR agent - notify (final step of workflow)
  // 4. Implementation/Review agents - skip (auto-loop, no user action needed)
  if (agentType && agentType !== 'pr' && agentType !== 'planification') {
    console.log(
      `[OneSignal] Skipping notification for ${agentType} agent (only PR and planification agents send notifications)`,
    );
    return null;
  }

  const title = workflowComplete ? 'Task Workflow Complete' : 'Claude Response Ready';
  const message = taskTitle
    ? workflowComplete
      ? `Task ready for review: ${taskTitle}`
      : `Response ready for: ${taskTitle}`
    : workflowComplete
      ? 'Task workflow complete, ready for review'
      : 'Claude has finished responding';

  // Build deep link URL for iOS app
  let deepLink: string | null = null;
  if (projectId && taskId) {
    deepLink = `claudeui://projects/${projectId}/tasks/${taskId}/chat/${conversationId}`;
  }

  return sendBannerNotification(userId, title, message, {
    type: workflowComplete ? 'workflow_complete' : 'claude_complete',
    taskId: taskId ? String(taskId) : null,
    conversationId: String(conversationId),
    projectId: projectId ? String(projectId) : null,
    deepLink,
  });
}

/**
 * Handle notification for task status change
 * Updates badge when task enters or leaves in_progress state
 */
async function notifyTaskStatusChange(
  userId: number,
  oldStatus: string,
  newStatus: string,
): Promise<unknown | null> {
  console.log(`[OneSignal] Task status changed for user ${userId}: ${oldStatus} -> ${newStatus}`);

  // Update badge when status changes to/from in_progress
  if (oldStatus === 'in_progress' || newStatus === 'in_progress') {
    console.log('[OneSignal] Status involves in_progress, updating badge...');
    return updateUserBadge(userId);
  }

  console.log('[OneSignal] Status change does not involve in_progress, skipping badge update');
  return null;
}

export {
  isConfigured,
  sendBannerNotification,
  sendBadgeUpdate,
  getInProgressTaskCount,
  updateUserBadge,
  notifyClaudeComplete,
  notifyTaskStatusChange,
};
