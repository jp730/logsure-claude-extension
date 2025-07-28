# LogSure Field Service Management - Desktop Extension

Professional field service task management integration for Claude Desktop.

## Features

- **View Daily Tasks**: Get today's scheduled field service tasks with location details
- **Task Management**: Check status, filter by completion state, and mark tasks complete
- **Location Hierarchy**: Browse your organization's locations and facility structure  
- **Natural Language**: Interact with your field service data through conversation with Claude

## Installation

1. Download the `.dxt` file from the releases page
2. Open Claude Desktop settings 
3. Drag the `.dxt` file into the Extensions section
4. Follow the configuration prompts to connect your LogSure account

## Configuration

You'll need to provide:

- **Clerk Token**: Your LogSure authentication token
- **Organization ID**: Your LogSure org ID (starts with `org_`)
- **User ID**: Your LogSure user ID (starts with `user_`)
- **Firebase Credentials**: Service account JSON for secure data access

## Usage Examples

Once configured, you can interact with Claude naturally:

- "Show me today's tasks"
- "What pending tasks do I have at Building A?"
- "Mark task ABC123 as completed with notes about the repair"
- "List all our locations"

## Security

- All authentication uses your existing LogSure account
- Data never leaves your organization
- Credentials stored securely in OS keychain
- Uses Firebase security rules and permissions

## Support

For support, visit: https://logsure.io/support

## License

MIT License - See LICENSE file for details