#!/usr/bin/env node

/**
 * LogSure Desktop Extension MCP Server
 * Professional field service management integration for Claude Desktop
 * 
 * Provides secure access to:
 * - Task viewing and completion
 * - Location management  
 * - Status tracking
 * 
 * Uses Cloud Functions API for simplified setup without Firebase credentials
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

class LogSureMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'logsure-field-service',
        version: '1.1.2',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Cloud Function base URL
    this.baseUrl = 'https://europe-west2-log-check-25ce4.cloudfunctions.net';
    this.setupTools();
  }

  async callCloudFunction(functionName, data) {
    try {
      console.error(`Calling Cloud Function: ${functionName}`, data);
      
      const response = await fetch(`${this.baseUrl}/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Cloud Function ${functionName} error:`, response.status, errorText);
        throw new Error(`Cloud Function call failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.error(`Cloud Function ${functionName} response received`);
      return result.result || result;
    } catch (error) {
      console.error(`Error calling Cloud Function ${functionName}:`, error);
      throw new Error(`Failed to call ${functionName}: ${error.message}`);
    }
  }

  setupTools() {
    // Handle tools list - using correct schema-based approach
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'get_tasks_today',
            description: 'Retrieve today\'s field service tasks with location details and status',
            inputSchema: {
              type: 'object',
              properties: {
                date: {
                  type: 'string',
                  description: 'Date in YYYY-MM-DD format (optional, defaults to today)',
                },
                locationId: {
                  type: 'string',
                  description: 'Filter by specific location ID (optional)',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Filter by task status (optional)',
                },
              },
            },
          },
          {
            name: 'get_locations',
            description: 'List all accessible locations in your organization hierarchy',
            inputSchema: {
              type: 'object',
              properties: {
                parentId: {
                  type: 'string',
                  description: 'Parent location ID to filter children (optional)',
                },
              },
            },
          },
          {
            name: 'get_task_status',
            description: 'Check task status and filter by completion state',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'Specific task ID to check (optional)',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Filter by status (optional)',
                },
              },
            },
          },
        ],
      };
    });

    // Handle tool calls - using correct schema-based approach
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'get_tasks_today':
            return await this.handleGetTasksToday(args);
          case 'get_locations':
            return await this.handleGetLocations(args);
          case 'get_task_status':
            return await this.handleGetTaskStatus(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`Tool execution error for ${name}:`, error);
        throw error;
      }
    });
  }

  async validateUserContext() {
    const { orgId, userId, clerkToken } = this.getUserConfig();
    
    try {
      console.error('Authenticating with Cloud Function...', { 
        userId: userId.substring(0, 8) + '...', 
        orgId: orgId.substring(0, 8) + '...' 
      });
      
      // Use the directFirebaseAuthMCP Cloud Function for authentication
      // The userId from config is actually the Clerk ID
      const result = await this.callCloudFunction('directFirebaseAuthMCP', {
        userId: userId, // This is the Clerk ID from the config
        orgId
      });

      if (!result.success) {
        throw new Error('Authentication failed');
      }

      const { user, firebaseToken } = result;
      
      console.error('Authentication successful:', {
        firebaseUid: user.firebaseUid,
        orgId: user.orgId,
        role: user.role,
        permissionsCount: user.permissions.length
      });

      return {
        userId: user.firebaseUid, // Firebase document ID
        orgId: user.orgId,
        role: user.role,
        permissions: user.permissions,
        firebaseToken
      };
    } catch (error) {
      console.error('User validation error:', error);
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  getUserConfig() {
    // Extract user configuration from environment variables
    // These are set by Claude Desktop from the manifest user_config
    const clerkToken = process.env.LOGSURE_CLERK_TOKEN;
    const orgId = process.env.LOGSURE_ORG_ID;
    const userId = process.env.LOGSURE_USER_ID;

    if (!clerkToken || !orgId || !userId) {
      throw new Error('Missing required authentication configuration. Please check your extension settings.');
    }

    return { clerkToken, orgId, userId };
  }

  hasPermission(userPermissions, requiredPermission) {
    return userPermissions.includes(requiredPermission);
  }


  async handleGetTasksToday(args) {
    const userContext = await this.validateUserContext();
    
    // Check permissions
    if (!this.hasPermission(userContext.permissions, 'view_assigned_tasks') &&
        !this.hasPermission(userContext.permissions, 'view_all_tasks')) {
      throw new Error('You do not have permission to view tasks');
    }

    const date = args.date || new Date().toISOString().split('T')[0];
    
    // Call the getTasksMCP Cloud Function
    const result = await this.callCloudFunction('getTasksMCP', {
      userId: userContext.userId,
      orgId: userContext.orgId,
      date,
      locationId: args.locationId,
      status: args.status
    });

    if (!result.success) {
      throw new Error('Failed to retrieve tasks');
    }

    const tasks = result.tasks;

    if (tasks.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No tasks found for ${date}${args.locationId ? ' at the specified location' : ''}.`,
          },
        ],
      };
    }

    const pendingTasks = tasks.filter((t) => t.status === 'pending');
    const completedTasks = tasks.filter((t) => t.status === 'completed');

    let response = `📅 **Field Service Tasks for ${date}**\n\n`;
    
    if (pendingTasks.length > 0) {
      response += `⏳ **Pending Tasks (${pendingTasks.length}):**\n`;
      pendingTasks.forEach((task) => {
        const locationName = task.locationPath?.join(' > ') || 'Unknown Location';
        response += `• **${task.title}** - ${locationName}\n`;
        response += `  Task ID: ${task.id}${task.assignedTo ? ` | Assigned: ${task.assignedTo}` : ''}\n`;
        if (task.instructions) response += `  Instructions: ${task.instructions}\n`;
        response += '\n';
      });
    }

    if (completedTasks.length > 0) {
      response += `✅ **Completed Tasks (${completedTasks.length}):**\n`;
      completedTasks.forEach((task) => {
        const locationName = task.locationPath?.join(' > ') || 'Unknown Location';
        response += `• **${task.title}** - ${locationName}\n`;
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  async handleGetLocations(args) {
    const userContext = await this.validateUserContext();
    
    if (!this.hasPermission(userContext.permissions, 'view_all_locations') &&
        !this.hasPermission(userContext.permissions, 'manage_locations')) {
      throw new Error('You do not have permission to view locations');
    }

    // Call the getLocationsMCP Cloud Function
    const result = await this.callCloudFunction('getLocationsMCP', {
      userId: userContext.userId,
      orgId: userContext.orgId,
      parentId: args.parentId
    });

    if (!result.success) {
      throw new Error('Failed to retrieve locations');
    }

    const locations = result.locations;

    if (locations.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No locations found for your organization.',
          },
        ],
      };
    }

    let response = `📍 **Your Organization Locations (${locations.length} total)**\n\n`;

    const locationsByLevel = {};
    locations.forEach((location) => {
      if (!locationsByLevel[location.level]) {
        locationsByLevel[location.level] = [];
      }
      locationsByLevel[location.level].push(location);
    });

    Object.keys(locationsByLevel).sort().forEach(level => {
      response += `**${level.toUpperCase()}:**\n`;
      locationsByLevel[level].forEach(location => {
        const path = location.path?.join(' > ') || location.name;
        response += `• ${location.name} (ID: \`${location.id}\`)\n`;
        if (path !== location.name) response += `  Path: ${path}\n`;
      });
      response += '\n';
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  async handleCompleteTask(args) {
    const userContext = await this.validateUserContext();
    
    if (!this.hasPermission(userContext.permissions, 'complete_tasks')) {
      throw new Error('You do not have permission to complete tasks');
    }

    if (!args.taskId) {
      throw new Error('Task ID is required');
    }

    const result = await this.completeTask(args.taskId, args.notes, userContext);

    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `✅ **Task completed successfully!**${args.notes ? `\n\n**Notes:** ${args.notes}` : ''}`,
          },
        ],
      };
    } else {
      throw new Error(result.message || 'Failed to complete task');
    }
  }

  async handleGetTaskStatus(args) {
    const userContext = await this.validateUserContext();
    
    if (!this.hasPermission(userContext.permissions, 'view_assigned_tasks') &&
        !this.hasPermission(userContext.permissions, 'view_all_tasks')) {
      throw new Error('You do not have permission to view tasks');
    }

    const today = new Date().toISOString().split('T')[0];
    
    // Call the getTasksMCP Cloud Function
    const result = await this.callCloudFunction('getTasksMCP', {
      userId: userContext.userId,
      orgId: userContext.orgId,
      date: today,
      locationId: args.locationId,
      status: args.status
    });

    if (!result.success) {
      throw new Error('Failed to retrieve task status');
    }

    const filteredTasks = result.tasks;

    if (filteredTasks.length === 0) {
      const statusText = args.status ? ` with status "${args.status}"` : '';
      return {
        content: [
          {
            type: 'text',
            text: `No tasks found${statusText} for today.`,
          },
        ],
      };
    }

    const statusText = args.status ? ` (${args.status})` : '';
    let response = `📊 **Task Status${statusText}** - ${filteredTasks.length} tasks\n\n`;

    filteredTasks.forEach((task) => {
      const locationName = task.locationPath?.join(' > ') || 'Unknown Location';
      const statusEmoji = task.status === 'completed' ? '✅' : '⏳';
      response += `${statusEmoji} **${task.title}**\n`;
      response += `   Location: ${locationName}\n`;
      response += `   Task ID: \`${task.id}\`\n`;
      if (task.assignedTo) response += `   Assigned: ${task.assignedTo}\n`;
      response += '\n';
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }


  async completeTask(taskId, notes, userContext) {
    try {
      // Use the existing completeTask Cloud Function
      const response = await fetch(`${this.baseUrl}/completeTask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userContext.firebaseToken}`,
        },
        body: JSON.stringify({
          data: {
            taskId,
            completionNotes: notes,
            userId: userContext.userId,
          }
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Complete task Cloud Function error:', response.status, errorText);
        throw new Error(`Cloud function call failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return { success: true, data: result.data };
    } catch (error) {
      console.error('Error completing task:', error);
      return { success: false, message: error.message };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('LogSure MCP Server connected via stdio');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('Shutting down LogSure MCP Server...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Shutting down LogSure MCP Server...');
  process.exit(0);
});

// Start the server
const server = new LogSureMCPServer();
server.run().catch((error) => {
  console.error('Failed to start LogSure MCP Server:', error);
  process.exit(1);
});