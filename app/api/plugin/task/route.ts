import { supabaseAdmin } from '@/lib/supabase';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import axios from 'axios';

const PLUGIN_SERVER_URL = process.env.PLUGIN_SERVER_URL || 'http://localhost:3600';
const SHARED_SECRET = process.env.PLUGIN_SHARED_SECRET;

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  
  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const { taskType, data } = await request.json();

    // Validate task type
    const validTaskTypes = [
      'INSERT_SCRIPT',
      'CREATE_UI',
      'INSERT_INSTANCE',
      'READ_EXPLORER',
      'START_PLAYTEST',
      'AUTO_PLAYTEST',
      'UPLOAD_IMAGE',
      'APPLY_IMAGE'
    ];

    if (!validTaskTypes.includes(taskType)) {
      return NextResponse.json(
        { error: 'Invalid task type' },
        { status: 400 }
      );
    }

    // Get user's active Roblox connection (session_id)
    const { data: connection } = await supabaseAdmin
      .from('roblox_connections')
      .select('session_id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (!connection) {
      return NextResponse.json(
        { error: 'No active Roblox Studio connection. Please open the plugin.' },
        { status: 400 }
      );
    }

    // Send task to plugin server
    const response = await axios.post(
      `${PLUGIN_SERVER_URL}/website/task`,
      {
        sessionId: connection.session_id,
        taskType,
        data
      },
      {
        headers: {
          'x-shared-secret': SHARED_SECRET,
          'Content-Type': 'application/json'
        }
      }
    );

    return NextResponse.json({
      success: true,
      taskId: response.data.taskId,
      message: 'Task sent to Roblox Studio plugin'
    });

  } catch (error: any) {
    console.error('Plugin task error:', error);
    
    if (error.response?.status === 404) {
      return NextResponse.json(
        { error: 'Plugin not connected. Please ensure Roblox Studio is open with the Revro plugin active.' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Failed to send task to plugin' },
      { status: 500 }
    );
  }
}
