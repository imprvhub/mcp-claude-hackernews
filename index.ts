import axios from 'axios';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const baseUrl = 'https://hacker-news.firebaseio.com/v0';

interface Story {
  id: number;
  title: string;
  by: string;
  time: number;
  url?: string;
  score: number;
  kids?: number[];
  text?: string;
  type: string;
}

interface Comment {
  id: number;
  by: string;
  time: number;
  text: string;
  kids?: number[];
}

interface FormattedStory {
  id: number;
  title: string;
  by: string;
  time: string;
  url?: string;
  score: number;
  commentsCount: number;
  text?: string;
}

interface FormattedComment {
  id: number;
  by: string;
  time: string;
  text: string;
  replies: number;
}

class HackerNewsAPI {
  async getLatestStories(limit = 50): Promise<Story[]> {
    try {
      const response = await axios.get(`${baseUrl}/newstories.json`);
      const storyIds = response.data || [];
      const storyPromises = storyIds.slice(0, limit).map((id: number) => this.getItemDetails(id));
      const stories = await Promise.all(storyPromises);
      return stories.filter((story): story is Story => story !== null && story.type === 'story');
    } catch (error) {
      console.error('Error fetching latest stories:', error);
      return [];
    }
  }

  async getTopStories(limit = 50): Promise<Story[]> {
    try {
      const response = await axios.get(`${baseUrl}/topstories.json`);
      const storyIds = response.data || [];
      const storyPromises = storyIds.slice(0, limit).map((id: number) => this.getItemDetails(id));
      const stories = await Promise.all(storyPromises);
      return stories.filter((story): story is Story => story !== null && story.type === 'story');
    } catch (error) {
      console.error('Error fetching top stories:', error);
      return [];
    }
  }

  async getBestStories(limit = 50): Promise<Story[]> {
    try {
      const response = await axios.get(`${baseUrl}/beststories.json`);
      const storyIds = response.data || [];
      const storyPromises = storyIds.slice(0, limit).map((id: number) => this.getItemDetails(id));
      const stories = await Promise.all(storyPromises);
      return stories.filter((story): story is Story => story !== null && story.type === 'story');
    } catch (error) {
      console.error('Error fetching best stories:', error);
      return [];
    }
  }

  async getItemDetails(itemId: number): Promise<Story | Comment | null> {
    try {
      const response = await axios.get(`${baseUrl}/item/${itemId}.json`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching item ${itemId}:`, error);
      return null;
    }
  }

  async getComments(commentIds: number[] = []): Promise<Comment[]> {
    if (!commentIds || commentIds.length === 0) {
      return [];
    }
    try {
      const commentPromises = commentIds.map(id => this.getItemDetails(id));
      const comments = await Promise.all(commentPromises);
      return comments.filter((comment): comment is Comment => comment !== null);
    } catch (error) {
      console.error('Failed to load comments:', error);
      return [];
    }
  }

  formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  }

  cleanText(text: string | undefined): string {
    if (!text) return '';
    return text
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/<[^>]*>?/gm, '');
  }
}

const api = new HackerNewsAPI();

let lastStoriesList: FormattedStory[] = [];

const server = new Server(
  {
    name: "mcp-claude-hackernews",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "hn_latest",
        description: "Get the latest/newest stories from Hacker News",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of stories to fetch (1-50, default: 10)",
              minimum: 1,
              maximum: 50,
              default: 10
            }
          }
        }
      },
      {
        name: "hn_top",
        description: "Get the top-ranked stories from Hacker News",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of stories to fetch (1-50, default: 10)",
              minimum: 1,
              maximum: 50,
              default: 10
            }
          }
        }
      },
      {
        name: "hn_best",
        description: "Get the best stories from Hacker News",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of stories to fetch (1-50, default: 10)",
              minimum: 1,
              maximum: 50,
              default: 10
            }
          }
        }
      },
      {
        name: "hn_story",
        description: "Get details for a specific story by ID",
        inputSchema: {
          type: "object",
          properties: {
            story_id: {
              type: "number",
              description: "The ID of the story to fetch"
            }
          },
          required: ["story_id"]
        }
      },
      {
        name: "hn_comments",
        description: "Get comments for a story (by story ID or index from last story list)",
        inputSchema: {
          type: "object",
          properties: {
            story_id: {
              type: "number",
              description: "The ID of the story to get comments for"
            },
            story_index: {
              type: "number",
              description: "The index (1-based) of the story from the last fetched list",
              minimum: 1
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  
try {
  if (name === "hn_latest") {
    const limit = typeof args?.limit === 'number' ? args.limit : 10;
    const stories = await api.getLatestStories(limit);
    const formattedStories = stories.map(story => ({
      id: story.id,
      title: story.title,
      by: story.by,
      time: api.formatTime(story.time),
      url: story.url,
      score: story.score,
      commentsCount: story.kids?.length || 0
    }));
    lastStoriesList = formattedStories;
    return {
      content: [
        {
          type: "text",
          text: formatStoriesAsText(formattedStories)
        }
      ]
    };
  }
  if (name === "hn_top") {
    const limit = typeof args?.limit === 'number' ? args.limit : 10;
    const stories = await api.getTopStories(limit);
    const formattedStories = stories.map(story => ({
      id: story.id,
      title: story.title,
      by: story.by,
      time: api.formatTime(story.time),
      url: story.url,
      score: story.score,
      commentsCount: story.kids?.length || 0
    }));
    lastStoriesList = formattedStories;
    return {
      content: [
        {
          type: "text",
          text: formatStoriesAsText(formattedStories)
        }
      ]
    };
  }
  if (name === "hn_best") {
    const limit = typeof args?.limit === 'number' ? args.limit : 10;
    const stories = await api.getBestStories(limit);
    const formattedStories = stories.map(story => ({
      id: story.id,
      title: story.title,
      by: story.by,
      time: api.formatTime(story.time),
      url: story.url,
      score: story.score,
      commentsCount: story.kids?.length || 0
    }));
    lastStoriesList = formattedStories;
    return {
      content: [
        {
          type: "text",
          text: formatStoriesAsText(formattedStories)
        }
      ]
    };
  }
  if (name === "hn_story") {
    const storyId = typeof args?.story_id === 'number' ? args.story_id : NaN;
    if (isNaN(storyId)) {
      throw new Error('Story ID must be a number');
    }
    const story = await api.getItemDetails(storyId) as Story | null;
    if (!story) {
      throw new Error(`Story with ID ${storyId} not found`);
    }
    const formattedStory = {
      id: story.id,
      title: story.title,
      by: story.by,
      time: api.formatTime(story.time),
      url: story.url,
      text: story.text ? api.cleanText(story.text) : '',
      score: story.score,
      commentsCount: story.kids?.length || 0
    };
    return {
      content: [
        {
          type: "text",
          text: formatStoryAsText(formattedStory)
        }
      ]
    };
  }
  if (name === "hn_comments") {
    const storyId = typeof args?.story_id === 'number' ? args.story_id : NaN;
    const storyIndex = typeof args?.story_index === 'number' ? args.story_index : NaN;

    if (isNaN(storyId) && isNaN(storyIndex)) {
      throw new Error('Either a story ID or a story index is required');
    }

    let targetStoryId: number;
    if (!isNaN(storyId)) {
      targetStoryId = storyId;
    } else if (!isNaN(storyIndex) && storyIndex > 0 && storyIndex <= lastStoriesList.length) {
      targetStoryId = lastStoriesList[storyIndex - 1].id;
    } else {
      throw new Error('Invalid story index or ID provided');
    }

    if (isNaN(targetStoryId)) {
      throw new Error('Story ID must be a number');
    }

    const story = await api.getItemDetails(targetStoryId) as Story | null;
    if (!story) {
      throw new Error(`Story with ID ${targetStoryId} not found`);
    }

    if (!story.kids || story.kids.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No comments found for story "${story.title}" (ID: ${story.id})`
          }
        ]
      };
    }

    const comments = await api.getComments(story.kids);
    const formattedComments = comments.map(comment => ({
      id: comment.id,
      by: comment.by,
      time: api.formatTime(comment.time),
      text: api.cleanText(comment.text),
      replies: comment.kids ? comment.kids.length : 0
    }));

    return {
      content: [
        {
          type: "text",
          text: formatCommentsAsText(story.title, formattedComments)
        }
      ]
    };
  }
  throw new Error(`Unknown tool: ${name}`);
} catch (error) {
    console.error(`Error handling request:`, error);
    throw error;
  }
});

function formatStoriesAsText(stories: FormattedStory[]): string {
  if (!stories || stories.length === 0) {
    return "No stories found.";
  }
  
  return stories.map((story, index) => {
    return `${index + 1}. ${story.title}
   ID: ${story.id}
   By: ${story.by}
   Published: ${story.time}
   Score: ${story.score}
   Comments: ${story.commentsCount}
   URL: ${story.url || 'N/A'}
   ------------------------------`;
  }).join('\n\n');
}

function formatStoryAsText(story: FormattedStory): string {
  if (!story) {
    return "Story not found.";
  }
  
  let result = `Title: ${story.title}
ID: ${story.id}
By: ${story.by}
Published: ${story.time}
Score: ${story.score}
Comments: ${story.commentsCount}
URL: ${story.url || 'N/A'}`;

  if (story.text) {
    result += `\n\nContent:\n${story.text}`;
  }
  
  return result;
}

function formatCommentsAsText(storyTitle: string, comments: FormattedComment[]): string {
  if (!comments || comments.length === 0) {
    return "No comments found.";
  }
  
  const header = `Comments for "${storyTitle}" (Total: ${comments.length}):\n`;
  
  const formattedComments = comments.map((comment, index) => {
    return `${index + 1}. Comment by ${comment.by} at ${comment.time}:
   "${comment.text}"
   ${comment.replies > 0 ? `(${comment.replies} replies)` : '(no replies)'}
   ------------------------------`;
  }).join('\n\n');
  
  return header + '\n' + formattedComments;
}

async function main() {
  const transport = new StdioServerTransport();
  
  try {
    await server.connect(transport);
    console.error("MCP Hacker News server running on stdio");
  } catch (error) {
    console.error("Error connecting to transport:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});