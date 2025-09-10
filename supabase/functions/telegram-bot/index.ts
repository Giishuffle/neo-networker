import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.2';

const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
}

interface UserSession {
  state: 'idle' | 'adding_person' | 'searching' | 'authenticating' | 'pending_update';
  step?: string;
  data?: any;
}

const AUTH_PASSWORD = "121212";
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    
    // Handle webhook setup request
    if (body.action === 'setup_webhook') {
      return await setupWebhook(body.webhook_url);
    }
    
    const update: TelegramUpdate = body;
    console.log('Received update:', JSON.stringify(update, null, 2));

    if (!update.message || !update.message.text) {
      return new Response('OK', { headers: corsHeaders });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text.trim();
    const userId = message.from.id;

    // Get user session from database
    console.log(`Processing message from user ${userId}: "${text}"`);
    const { data: user } = await supabase
      .from('telegram_users')
      .select('current_state, state_data, is_authenticated')
      .eq('telegram_id', userId)
      .single();

    console.log(`User state from DB:`, user);
    
    let session = {
      state: user?.current_state || 'idle',
      step: user?.state_data?.step,
      data: user?.state_data?.data || {}
    };

    if (text === '/start') {
      // Check if user is already authenticated
      const isAuth = await checkUserAuthentication(userId);
      if (isAuth) {
        await updateUserState(userId, 'idle', {});
        await setCommands(chatId);
        await sendMessage(chatId, 
          "Welcome back to VC Search Engine Bot! 🚀\n\n" +
          "You are authenticated and ready to use the bot.\n\n" +
          "💡 Just type anything to search the database!\n\n" +
          "Commands:\n" +
          "🔍 /search - Search people in database\n" +
          "➕ /add - Add a new person\n" +
          "❓ /help - Show this help message"
        );
      } else {
        await updateUserState(userId, 'authenticating', {});
        await sendMessage(chatId, 
          "Welcome to VC Search Engine Bot! 🚀\n\n" +
          "🔐 Please enter the password to access the system:"
        );
      }
    } else if (text === '/help') {
      if (!await checkUserAuthentication(userId)) {
        await sendMessage(chatId, "🔐 Please authenticate first using /start");
        return new Response('OK', { headers: corsHeaders });
      }
      await sendMessage(chatId,
        "VC Search Engine Bot Commands:\n\n" +
        "💡 <b>Quick Search:</b> Just type anything to search!\n" +
        "Example: 'fintech', 'Sarah', 'Sequoia'\n\n" +
        "📝 <b>Tasks:</b> 'add task call John tomorrow', 'show all tasks', 'update task 5 status done'\n" +
        "👥 <b>People:</b> 'add John Doe from TechCorp', 'search ai engineer'\n\n" +
        "Commands:\n" +
        "🔍 /search - Search for people\n" +
        "➕ /add - Add a new person to the database\n" +
        "❌ /cancel - Cancel current operation\n\n" +
        "Simply type your request in natural language!"
      );
    } else if (text === '/search') {
      if (!await checkUserAuthentication(userId)) {
        await sendMessage(chatId, "🔐 Please authenticate first using /start");
        return new Response('OK', { headers: corsHeaders });
      }
      await updateUserState(userId, 'searching', {});
      await sendMessage(chatId, "🔍 What would you like to search for? (name, company, hashtag, or specialty)");
    } else if (text === '/add') {
      if (!await checkUserAuthentication(userId)) {
        await sendMessage(chatId, "🔐 Please authenticate first using /start");
        return new Response('OK', { headers: corsHeaders });
      }
      await updateUserState(userId, 'adding_person', { step: 'name', data: {} });
      await sendMessage(chatId, "➕ Let's add a new person! What's their full name?");
    } else if (text === '/cancel') {
      await updateUserState(userId, 'idle', {});
      await sendMessage(chatId, "❌ Operation cancelled. Type /help to see available commands.");
    } else {
      // Handle conversation flows and regular messages
      console.log(`Current session state: ${session.state}`);
      if (session.state === 'authenticating') {
        console.log(`User ${userId} attempting authentication with: ${text}`);
        await handleAuthentication(chatId, text, userId, message.from);
        await updateUserState(userId, 'idle', {});
      } else if (session.state === 'pending_update') {
        // Handle approval for person updates
        if (text === '1') {
          const { person_id, updates } = user?.state_data || {};
          if (person_id && updates) {
            try {
              const { error } = await supabase
                .from('people')
                .update(updates)
                .eq('id', person_id);

              if (error) {
                await sendMessage(chatId, "❌ Error updating person. Please try again.");
              } else {
                await sendMessage(chatId, "✅ Person updated successfully!");
              }
            } catch (error) {
              await sendMessage(chatId, "❌ Error updating person. Please try again.");
            }
          }
        } else {
          await sendMessage(chatId, "❌ Update cancelled.");
        }
        await updateUserState(userId, 'idle', {});
      } else if (session.state === 'searching') {
        if (!await checkUserAuthentication(userId)) {
          await sendMessage(chatId, "🔐 Please authenticate first using /start");
          return new Response('OK', { headers: corsHeaders });
        }
        await handleSearch(chatId, text);
        await updateUserState(userId, 'idle', {});
      } else if (session.state === 'adding_person') {
        if (!await checkUserAuthentication(userId)) {
          await sendMessage(chatId, "🔐 Please authenticate first using /start");
          return new Response('OK', { headers: corsHeaders });
        }
        await handleAddPerson(chatId, text, session, userId);
      } else {
        // For authenticated users, handle messages based on prefix
        if (await checkUserAuthentication(userId)) {
          if (text.startsWith('.')) {
            // Remove the dot and search people
            const searchQuery = text.substring(1).trim();
            if (searchQuery) {
              await handleSearch(chatId, searchQuery);
            } else {
              await sendMessage(chatId, "❓ Please provide a search term after the dot (e.g., '.john doe')");
            }
          } else {
            // Use ChatGPT function router
            await handleFunctionRouter(chatId, text, userId);
          }
        } else {
          await sendMessage(chatId, "🔐 Please authenticate first using /start");
        }
      }
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (error) {
    console.error('Error processing update:', error);
    return new Response('Error', { status: 500, headers: corsHeaders });
  }
});

async function setupWebhook(webhookUrl: string) {
  if (!TELEGRAM_API_KEY) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'TELEGRAM_API_KEY not set' 
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/setWebhook`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        max_connections: 40,
        allowed_updates: ["message"]
      })
    });

    const result = await response.json();
    
    if (result.ok) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Webhook setup successfully' 
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Telegram API error: ${result.description}` 
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: `Failed to setup webhook: ${error.message}` 
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
}

async function sendMessage(chatId: number, text: string) {
  if (!TELEGRAM_API_KEY) {
    console.error('TELEGRAM_API_KEY not set');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/sendMessage`;
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

async function setCommands(chatId: number) {
  if (!TELEGRAM_API_KEY) {
    console.error('TELEGRAM_API_KEY not set');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/setMyCommands`;
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Start the bot and authenticate' },
          { command: 'search', description: 'Search for people in database' },
          { command: 'add', description: 'Add a new person to database' },
          { command: 'help', description: 'Show help information' },
          { command: 'cancel', description: 'Cancel current operation' }
        ]
      })
    });
  } catch (error) {
    console.error('Error setting commands:', error);
  }
}

async function checkUserAuthentication(telegramId: number): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('telegram_users')
      .select('is_authenticated')
      .eq('telegram_id', telegramId)
      .eq('is_authenticated', true)
      .single();

    if (error || !data) {
      return false;
    }

    return data.is_authenticated;
  } catch (error) {
    console.error('Error checking authentication:', error);
    return false;
  }
}

async function updateUserState(telegramId: number, state: string, stateData: any) {
  try {
    // First get the current user to preserve authentication status
    const { data: currentUser } = await supabase
      .from('telegram_users')
      .select('is_authenticated')
      .eq('telegram_id', telegramId)
      .single();

    await supabase
      .from('telegram_users')
      .upsert({
        telegram_id: telegramId,
        current_state: state,
        state_data: stateData,
        // Preserve existing authentication status
        is_authenticated: currentUser?.is_authenticated || false
      }, {
        onConflict: 'telegram_id'
      });
    console.log(`Updated user ${telegramId} state to: ${state}, auth status preserved`);
  } catch (error) {
    console.error('Error updating user state:', error);
  }
}

async function handleAuthentication(chatId: number, password: string, telegramId: number, userInfo: any) {
  if (password === AUTH_PASSWORD) {
    try {
      // Insert or update user in telegram_users table
      const { error } = await supabase
        .from('telegram_users')
        .upsert({
          telegram_id: telegramId,
          telegram_username: userInfo.username || null,
          first_name: userInfo.first_name || null,
          is_authenticated: true,
          authenticated_at: new Date().toISOString()
        }, {
          onConflict: 'telegram_id'
        });

      if (error) {
        console.error('Authentication error:', error);
        await sendMessage(chatId, "❌ Authentication failed. Please try again with /start");
        return;
      }

      await setCommands(chatId);
        await sendMessage(chatId, 
          "✅ Authentication successful! Welcome to VC Search Engine!\n\n" +
          "💡 <b>You can now just type anything!</b>\n" +
          "Examples:\n" +
          "• 'search fintech startups'\n" +
          "• 'add task call John tomorrow'\n" +
          "• 'show all tasks'\n" +
          "• 'add Sarah from Google'\n\n" +
          "Commands:\n" +
          "🔍 /search - Search people\n" +
          "➕ /add - Add a new person\n" +
          "❓ /help - Show help message"
        );
    } catch (error) {
      console.error('Database error:', error);
      await sendMessage(chatId, "❌ Authentication failed. Please try again with /start");
    }
  } else {
    await sendMessage(chatId, "❌ Incorrect password. Please try again or use /start to restart.");
  }
}

async function handleFunctionRouter(chatId: number, text: string, userId: number) {
  if (!OPENAI_API_KEY) {
    await sendMessage(chatId, "❌ OpenAI API not configured. Please contact administrator.");
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: `You are a function router.  
Your job: take any user request and map it to EXACTLY ONE of these functions, and return ONLY a JSON array [function_number, parameters].  

---

### Functions

1. search_information(words: array of strings)

2. add_task(task_text: string, assign_to?: string, due_date?: string, status?: string, label?: string, priority?: string)  
   - Rule: If no "task" is mentioned in the user prompt, it is not this function.
   - Example: "add task to meet roee on thursday" → [2, {"text": "meet roee on thursday", "due_date": "thursday"}]
   - Always return object with "text" field for task description

3. remove_task(task_id: string or number)

4. add_alert_to_task(task_id: string or number)

5. show_all_tasks(period: "daily" | "weekly" | "monthly" | "all", filter?: object)  
   - Example: "show tasks high priority" → [5, {"filter":"priority","value":"high"}]  

6. add_new_people(people_data: array of structured fields like Full Name, Email, LinkedIn, Company, Categories, Status, Newsletter, etc.)

7. show_all_meetings(period: "today" | "weekly" | "monthly")

8. update_task(task_id: string or number, field: string, new_value: string)  
   - Example: "status of task 4 is done" → [8, {"task_id":4,"field":"status","new_value":"done"}]

9. update_person(person_id: string or number, updates: object)  
   - Rule: If user does not specify which person, assume it is the last person they added.  
   - Before applying update: always return a preview of the person record and ask the user for approval (0 = cancel, 1 = approve).  

---

### Rules
- Always return [function_number, parameters].  
- If no parameter is needed, return null.  
- If multiple matches are possible, choose the most direct.  
- If user asks for "tasks" without mentioning "task", it should NOT trigger add_task.` 
          },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 150
      }),
    });

    const data = await response.json();
    const functionCall = data.choices[0].message.content.trim();
    
    console.log(`Function router response: ${functionCall}`);
    
    try {
      const [functionNumber, parameters] = JSON.parse(functionCall);
      await executeBotFunction(chatId, functionNumber, parameters, userId, text);
    } catch (parseError) {
      console.error('Failed to parse function response:', parseError);
      // Fallback to search
      await handleSearch(chatId, text);
    }
    
  } catch (error) {
    console.error('Function router error:', error);
    // Fallback to search
    await handleSearch(chatId, text);
  }
}

async function executeBotFunction(chatId: number, functionNumber: number, parameters: any, userId: number, originalText: string) {
  console.log(`Executing function ${functionNumber} with params:`, parameters);
  
  switch (functionNumber) {
    case 1: // search_information
      if (parameters && Array.isArray(parameters)) {
        const searchQuery = parameters.join(' ');
        await handleSearch(chatId, searchQuery);
      } else {
        await handleSearch(chatId, originalText);
      }
      break;
      
    case 2: // add_task
      await handleAddTask(chatId, parameters, userId);
      break;
      
    case 3: // remove_task
      await handleRemoveTask(chatId, parameters);
      break;
      
    case 4: // add_alert_to_task
      await handleAddAlertToTask(chatId, parameters);
      break;
      
    case 5: // show_all_tasks
      await handleShowTasks(chatId, parameters);
      break;
      
    case 6: // add_new_people
      await handleAddPeopleFromBot(chatId, parameters, userId);
      break;
      
    case 7: // show_all_meetings
      await handleShowMeetings(chatId, parameters);
      break;
      
    case 8: // update_task
      await handleUpdateTask(chatId, parameters);
      break;
      
    case 9: // update_person
      await handleUpdatePerson(chatId, parameters, userId);
      break;
      
    default:
      await sendMessage(chatId, `🚧 Function ${functionNumber} is not implemented yet.`);
  }
}

// Task Management Functions
async function handleAddTask(chatId: number, parameters: any, userId: number) {
  try {
    console.log('Add task parameters received:', parameters);
    
    let taskText = '';
    let assignTo = null;
    let dueDate = null;
    let status = 'pending';
    let label = null;
    let priority = 'medium';
    
    // Handle different parameter formats
    if (typeof parameters === 'string') {
      taskText = parameters;
    } else if (parameters && typeof parameters === 'object') {
      taskText = parameters.text || parameters.task_text || parameters.title || '';
      assignTo = parameters.assign_to || parameters.assignTo || null;
      dueDate = parameters.due_date || parameters.dueDate || null;
      status = parameters.status || 'pending';
      label = parameters.label || null;
      priority = parameters.priority || 'medium';
    }
    
    if (!taskText || taskText.trim().length === 0) {
      await sendMessage(chatId, "❌ I need task details. Try: 'Add task call John tomorrow'");
      return;
    }

    // Get the admin user to use as created_by for bot tasks
    const { data: adminUser } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', 'guy@wershuffle.com')
      .single();

    const task = {
      text: taskText.trim(),
      assign_to: assignTo,
      due_date: dueDate,
      status: status,
      label: label,
      priority: priority,
      created_by: adminUser?.id || null
    };

    console.log('Inserting task:', task);
    const { error } = await supabase.from('tasks').insert([task]);

    if (error) {
      console.error('Add task error:', error);
      await sendMessage(chatId, "❌ Error adding task. Please try again.");
      return;
    }

    await sendMessage(chatId, `✅ Task added: "${task.text}" (${task.priority} priority, ${task.status})`);
  } catch (error) {
    console.error('Add task error:', error);
    await sendMessage(chatId, "❌ Error adding task. Please try again.");
  }
}

async function handleRemoveTask(chatId: number, parameters: any) {
  try {
    if (!parameters || (!parameters.task_id && typeof parameters !== 'string' && typeof parameters !== 'number')) {
      await sendMessage(chatId, "❌ I need a task ID to remove. Try: 'Remove task 5'");
      return;
    }

    const taskId = parameters.task_id || parameters;
    const { error } = await supabase.from('tasks').delete().eq('task_id', taskId);

    if (error) {
      await sendMessage(chatId, "❌ Error removing task. Please try again.");
      return;
    }

    await sendMessage(chatId, `✅ Task ${taskId} removed successfully.`);
  } catch (error) {
    await sendMessage(chatId, "❌ Error removing task. Please try again.");
  }
}

async function handleAddAlertToTask(chatId: number, parameters: any) {
  await sendMessage(chatId, "🚧 Task alerts feature coming soon!");
}

async function handleShowTasks(chatId: number, parameters: any) {
  try {
    let query = supabase.from('tasks').select('*');
    
    // Apply filters if provided
    if (parameters && parameters.filter) {
      const { filter, value } = parameters;
      query = query.eq(filter, value);
    }

    const { data: tasks, error } = await query.limit(10);

    if (error) {
      await sendMessage(chatId, "❌ Error fetching tasks. Please try again.");
      return;
    }

    if (!tasks || tasks.length === 0) {
      await sendMessage(chatId, "📝 No tasks found.");
      return;
    }

    let response = `📝 Found ${tasks.length} task(s):\n\n`;
    tasks.forEach((task: any, index: number) => {
      response += `${index + 1}. <b>${task.text}</b>\n`;
      response += `   ID: ${task.task_id} | Status: ${task.status} | Priority: ${task.priority}\n`;
      if (task.assign_to) response += `   Assigned: ${task.assign_to}\n`;
      if (task.due_date) response += `   Due: ${task.due_date}\n`;
      response += '\n';
    });

    await sendMessage(chatId, response);
  } catch (error) {
    await sendMessage(chatId, "❌ Error fetching tasks. Please try again.");
  }
}

async function handleUpdateTask(chatId: number, parameters: any) {
  try {
    if (!parameters || !parameters.task_id || !parameters.field || !parameters.new_value) {
      await sendMessage(chatId, "❌ I need task ID, field, and new value. Try: 'Set task 5 status to done'");
      return;
    }

    const { task_id, field, new_value } = parameters;
    const updateData = { [field]: new_value };
    
    const { error } = await supabase.from('tasks').update(updateData).eq('task_id', task_id);

    if (error) {
      await sendMessage(chatId, "❌ Error updating task. Please try again.");
      return;
    }

    await sendMessage(chatId, `✅ Task ${task_id} updated: ${field} = ${new_value}`);
  } catch (error) {
    await sendMessage(chatId, "❌ Error updating task. Please try again.");
  }
}

// People Management Functions
async function handleAddPeopleFromBot(chatId: number, parameters: any, userId: number) {
  try {
    if (!Array.isArray(parameters)) {
      await sendMessage(chatId, "❌ I need person details. Try: 'Add John Doe from TechCorp'");
      return;
    }

    const results = [];
    for (const personData of parameters) {
      const person = {
        full_name: personData.full_name || personData.name,
        email: personData.email || null,
        company: personData.company || null,
        categories: personData.categories || null,
        status: personData.status || null,
        linkedin_profile: personData.linkedin_profile || null,
        newsletter: personData.newsletter || false,
        should_avishag_meet: personData.should_avishag_meet || false
      };

      if (person.full_name) {
        const { error } = await supabase.from('people').insert([person]);
        if (!error) {
          results.push(person.full_name);
        }
      }
    }

    if (results.length > 0) {
      await sendMessage(chatId, `✅ Added ${results.length} person(s): ${results.join(', ')}`);
    } else {
      await sendMessage(chatId, "❌ Could not add any people. Please check the details.");
    }
  } catch (error) {
    await sendMessage(chatId, "❌ Error adding people. Please try again.");
  }
}

async function handleShowMeetings(chatId: number, parameters: any) {
  await sendMessage(chatId, "🚧 Meetings feature coming soon!");
}

async function handleUpdatePerson(chatId: number, parameters: any, userId: number) {
  try {
    if (!parameters || !parameters.person_id) {
      // Get last added person by this user
      const { data: lastPerson } = await supabase
        .from('people')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!lastPerson) {
        await sendMessage(chatId, "❌ No person found to update. Please specify a person ID.");
        return;
      }

      // Show preview and ask for approval
      let preview = `👤 <b>${lastPerson.full_name}</b>\n`;
      if (lastPerson.company) preview += `🏢 ${lastPerson.company}\n`;
      if (lastPerson.email) preview += `📧 ${lastPerson.email}\n`;
      
      preview += "\n🔄 Proposed updates:\n";
      Object.entries(parameters.updates || {}).forEach(([key, value]) => {
        preview += `• ${key}: ${value}\n`;
      });
      
      preview += "\nReply: 1 to approve, 0 to cancel";
      await sendMessage(chatId, preview);
      
      // Store pending update in user state
      await updateUserState(userId, 'pending_update', {
        person_id: lastPerson.id,
        updates: parameters.updates
      });
      return;
    }

    // Direct update with person_id
    const { error } = await supabase
      .from('people')
      .update(parameters.updates)
      .eq('id', parameters.person_id);

    if (error) {
      await sendMessage(chatId, "❌ Error updating person. Please try again.");
      return;
    }

    await sendMessage(chatId, "✅ Person updated successfully!");
  } catch (error) {
    await sendMessage(chatId, "❌ Error updating person. Please try again.");
  }
}

async function handleSearch(chatId: number, query: string) {
  try {
    const searchTerm = query.toLowerCase();
    
    const { data: people, error } = await supabase
      .from('people')
      .select('*')
      .or(`full_name.ilike.%${searchTerm}%,company.ilike.%${searchTerm}%,categories.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%,status.ilike.%${searchTerm}%,linkedin_profile.ilike.%${searchTerm}%,poc_in_apex.ilike.%${searchTerm}%,who_warm_intro.ilike.%${searchTerm}%,agenda.ilike.%${searchTerm}%,meeting_notes.ilike.%${searchTerm}%,more_info.ilike.%${searchTerm}%`)
      .limit(10);

    if (error) {
      console.error('Search error:', error);
      await sendMessage(chatId, "❌ Error searching database. Please try again.");
      return;
    }

    if (!people || people.length === 0) {
      await sendMessage(chatId, `🔍 No results found for "${query}"`);
      return;
    }

    let response = `🔍 Found ${people.length} result(s) for "<b>${query}</b>":\n\n`;
    
    people.forEach((person: any, index: number) => {
      response += `${index + 1}. <b>${person.full_name}</b>\n`;
      if (person.company) response += `   🏢 ${person.company}\n`;
      if (person.email) response += `   📧 ${person.email}\n`;
      if (person.categories) response += `   🏷️ ${person.categories}\n`;
      if (person.status) response += `   📊 Status: ${person.status}\n`;
      if (person.poc_in_apex) response += `   👥 POC in APEX: ${person.poc_in_apex}\n`;
      if (person.who_warm_intro) response += `   🤝 Warm Intro: ${person.who_warm_intro}\n`;
      if (person.linkedin_profile) response += `   🔗 LinkedIn: ${person.linkedin_profile}\n`;
      if (person.newsletter) response += `   📰 Newsletter: ✅\n`;
      if (person.should_avishag_meet) response += `   👩‍💼 Should Avishag Meet: ✅\n`;
      response += '\n';
    });

    await sendMessage(chatId, response);
  } catch (error) {
    console.error('Search error:', error);
    await sendMessage(chatId, "❌ Error performing search. Please try again.");
  }
}

async function handleAddPerson(chatId: number, text: string, session: any, userId: number) {
  if (!session.data) session.data = {};

  switch (session.step) {
    case 'name':
      session.data.full_name = text;
      session.step = 'email';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "📧 What's their email address? (or type 'skip')");
      break;

    case 'email':
      session.data.email = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'company';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "👔 What company do they work for? (or type 'skip')");
      break;

    case 'company':
      session.data.company = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'categories';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "🏷️ What categories/tags describe them? (comma-separated, or type 'skip')");
      break;

    case 'categories':
      session.data.categories = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'status';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "📊 What's their status? (or type 'skip')");
      break;

    case 'status':
      session.data.status = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'linkedin';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "🔗 What's their LinkedIn profile URL? (or type 'skip')");
      break;

    case 'linkedin':
      session.data.linkedin_profile = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'poc_apex';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "👥 Who is the POC in APEX? (or type 'skip')");
      break;

    case 'poc_apex':
      session.data.poc_in_apex = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'warm_intro';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "🤝 Who can provide a warm intro? (or type 'skip')");
      break;

    case 'warm_intro':
      session.data.who_warm_intro = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'more_info';
      await updateUserState(userId, 'adding_person', { ...session });
      await sendMessage(chatId, "📝 Any additional information? (or type 'skip')");
      break;

    case 'more_info':
      session.data.more_info = text.toLowerCase() === 'skip' ? null : text;
      
      // Save to database
      try {
        const { error } = await supabase
          .from('people')
          .insert([session.data]);

        if (error) {
          console.error('Insert error:', error);
          await sendMessage(chatId, "❌ Error adding person to database. Please try again with /add");
          await updateUserState(userId, 'idle', {});
          return;
        }

        let response = `✅ Successfully added: <b>${session.data.full_name}</b>\n`;
        if (session.data.company) response += `🏢 Company: ${session.data.company}\n`;
        if (session.data.email) response += `📧 Email: ${session.data.email}\n`;
        if (session.data.categories) response += `🏷️ Categories: ${session.data.categories}\n`;
        
        await sendMessage(chatId, response);
        await updateUserState(userId, 'idle', {});
      } catch (error) {
        console.error('Database error:', error);
        await sendMessage(chatId, "❌ Error adding person. Please try again with /add");
        await updateUserState(userId, 'idle', {});
      }
      break;

    default:
      await sendMessage(chatId, "❌ Something went wrong. Please try again with /add");
      await updateUserState(userId, 'idle', {});
  }
}