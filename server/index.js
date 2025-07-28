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
 * Uses Firebase Cloud Functions for data access with proper authentication
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const admin = require('firebase-admin');

class LogSureMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'logsure-field-service',
        version: '1.0.9',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Don't initialize Firebase during construction to avoid timeout
    // It will be initialized when first needed
    this.db = null;
    this.setupTools();
  }

  initializeFirebase() {
    if (this.db) return; // Already initialized
    
    try {
      console.error('Initializing Firebase...');
      // Initialize Firebase Admin with credentials from environment
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
      this.db = admin.firestore();
      console.error('Firebase initialized successfully');
    } catch (error) {
      console.error('Firebase initialization failed:', error.message);
      throw new Error('Failed to initialize Firebase connection');
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
      console.error('Authenticating with Cloud Function...', { userId: userId.substring(0, 8) + '...', orgId: orgId.substring(0, 8) + '...' });
      
      // User ID is now the Firebase document ID directly
      console.error('Using Firebase document ID directly:', userId);
      console.error('Organization ID:', orgId);
      
      const userDoc = await this.db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        throw new Error('User document not found - check your LogSure User ID');
      }
      
      const userData = userDoc.data();
      console.error('Found user data for:', userId);
      console.error('User orgId:', userData.orgId);
      console.error('Expected orgId:', orgId);
      console.error('DEBUG: Full userData:', JSON.stringify(userData, null, 2));
      
      if (userData.orgId !== orgId) {
        throw new Error(`Organization mismatch - user belongs to ${userData.orgId}, but config uses ${orgId}`);
      }
      
      const firebaseUid = userDoc.id;
      const clerkUserId = userData.clerkId; // Get the original Clerk ID from the user document
      
      console.error('DEBUG: Sending to Cloud Function:');
      console.error('- clerkUserId:', clerkUserId);
      console.error('- orgId:', orgId);
      console.error('- userData.clerkId exists:', !!userData.clerkId);
      
      // Call the new MCP-specific Cloud Function for authentication
      const response = await fetch('https://europe-west2-log-check-25ce4.cloudfunctions.net/directFirebaseAuthMCP', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: { userId: clerkUserId, orgId }
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Auth response error:', response.status, errorText);
        throw new Error(`Authentication failed: ${response.status}`);
      }

      const result = await response.json();
      console.error('Cloud Function response:', JSON.stringify(result, null, 2));
      const firebaseToken = result.firebaseToken;
      
      const orgDoc = await this.db.collection('organisations').doc(orgId).get();
      const orgData = orgDoc.data();
      const userRole = userData?.role || 5;
      
      const permissions = orgData?.permissions
        ?.filter((perm) => perm.roles.includes(userRole))
        ?.map((perm) => perm.id) || [];

      return {
        userId: firebaseUid, // Use the Firebase document ID, not Clerk ID
        orgId,
        role: userRole,
        permissions,
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
      throw new Error('Missing required authentication configuration');
    }

    return { clerkToken, orgId, userId };
  }

  hasPermission(userPermissions, requiredPermission) {
    return userPermissions.includes(requiredPermission);
  }

  async handleDebugAuth(args) {
    try {
      const { clerkToken, orgId, userId } = this.getUserConfig();
      
      let response = `🔍 **Debug Authentication**\n\n`;
      response += `**Environment Variables:**\n`;
      response += `- Clerk Token: ${clerkToken ? 'SET (' + clerkToken.substring(0, 10) + '...)' : 'NOT SET'}\n`;
      response += `- Org ID: ${orgId || 'NOT SET'}\n`;
      response += `- User ID: ${userId || 'NOT SET'}\n`;
      response += `- Firebase Creds: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'NOT SET'}\n\n`;

      // Try Firebase connection
      try {
        this.initializeFirebase();
        response += `**Firebase:** ✅ Connected\n\n`;
        
        // Try direct user document lookup (since userId is now the Firebase doc ID)
        response += `**User Lookup:**\n`;
        try {
          const userDoc = await this.db.collection('users').doc(userId).get();
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            response += `✅ **User Found:**\n`;
            response += `- User ID: ${userDoc.id}\n`;
            response += `- Organization: ${userData.orgId}\n`;
            response += `- Org ID Match: ${userData.orgId === orgId ? '✅' : '❌'}\n\n`;
            
            if (userData.orgId === orgId) {
              response += `🎉 **Configuration is correct! You should be able to use all tools now.**\n`;
            } else {
              response += `⚠️ **Org ID Mismatch:**\n`;
              response += `- Your config Org ID: ${orgId}\n`;
              response += `- User's actual Org ID: ${userData.orgId}\n`;
              response += `Update your Organization ID to: \`${userData.orgId}\`\n`;
            }
          } else {
            response += `❌ User document not found with ID: ${userId}\n`;
            response += `Please check your LogSure User ID is correct.\n`;
          }
        } catch (docError) {
          response += `❌ Error looking up user: ${docError.message}\n`;
        }
        
      } catch (error) {
        response += `**Firebase:** ❌ Error: ${error.message}\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Debug failed: ${error.message}`,
          },
        ],
      };
    }
  }

  async handleGetTasksToday(args) {
    this.initializeFirebase();
    const userContext = await this.validateUserContext();
    
    // Check permissions
    if (!this.hasPermission(userContext.permissions, 'view_assigned_tasks') &&
        !this.hasPermission(userContext.permissions, 'view_all_tasks')) {
      throw new Error('You do not have permission to view tasks');
    }

    const date = args.date || new Date().toISOString().split('T')[0];
    const tasks = await this.getTasks(date, userContext, args.locationId);

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
    this.initializeFirebase();
    const userContext = await this.validateUserContext();
    
    if (!this.hasPermission(userContext.permissions, 'view_all_locations') &&
        !this.hasPermission(userContext.permissions, 'manage_locations')) {
      throw new Error('You do not have permission to view locations');
    }

    const locations = await this.getLocations(userContext.orgId);

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
    this.initializeFirebase();
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
    this.initializeFirebase();
    const userContext = await this.validateUserContext();
    
    if (!this.hasPermission(userContext.permissions, 'view_assigned_tasks') &&
        !this.hasPermission(userContext.permissions, 'view_all_tasks')) {
      throw new Error('You do not have permission to view tasks');
    }

    const today = new Date().toISOString().split('T')[0];
    const tasks = await this.getTasks(today, userContext, args.locationId);
    const filteredTasks = args.status ? tasks.filter((t) => t.status === args.status) : tasks;

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

  // Firebase data access methods
  async getTasks(date, userContext, locationId) {
    try {
      const tasksRef = this.db.collection('scheduledTasks');
      let query = tasksRef.where('orgId', '==', userContext.orgId);
      
      // Add date filter - use ISO strings like the other functions
      const startOfDay = date + 'T00:00:00.000Z';
      const endOfDay = date + 'T23:59:59.999Z';
      query = query.where('scheduledFor', '>=', startOfDay)
                   .where('scheduledFor', '<=', endOfDay);

      if (locationId) {
        query = query.where('locationId', '==', locationId);
      }

      const snapshot = await query.get();
      const tasks = [];

      for (const doc of snapshot.docs) {
        const taskData = doc.data();
        
        // Get location path
        let locationPath = [];
        if (taskData.locationId) {
          try {
            const locationDoc = await this.db.collection('locations').doc(taskData.locationId).get();
            if (locationDoc.exists) {
              const location = locationDoc.data();
              locationPath = location.path || [location.name];
            }
          } catch (error) {
            console.error('Error getting location:', error);
          }
        }

        tasks.push({
          id: doc.id,
          title: taskData.title,
          status: taskData.status || 'pending',
          instructions: taskData.instructions,
          assignedTo: taskData.assignedTo,
          locationPath,
        });
      }

      return tasks;
    } catch (error) {
      console.error('Error getting tasks:', error);
      throw new Error('Failed to retrieve tasks');
    }
  }

  async getLocations(orgId) {
    try {
      const locationsRef = this.db.collection('locations');
      const query = locationsRef.where('orgId', '==', orgId);
      const snapshot = await query.get();

      const locations = [];
      snapshot.forEach((doc) => {
        const locationData = doc.data();
        locations.push({
          id: doc.id,
          name: locationData.name,
          level: locationData.level || 'unknown',
          path: locationData.path || [],
        });
      });

      return locations;
    } catch (error) {
      console.error('Error getting locations:', error);
      throw new Error('Failed to retrieve locations');
    }
  }

  async completeTask(taskId, notes, userContext) {
    try {
      // Use your existing Cloud Function
      const response = await fetch('https://europe-west2-log-check-25ce4.cloudfunctions.net/completeTask', {
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
        throw new Error(`Cloud function call failed: ${response.status}`);
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