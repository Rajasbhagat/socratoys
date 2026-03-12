import fs from 'fs';

let html = fs.readFileSync('admin.html', 'utf8');

// 1. Add switchTab logic
html = html.replace('body {', `body {\n            flex-direction: column;`);

// 2. Wrap the view containers and add headers
const bodyRegex = /<body>\s*<!-- Sidebar: Session List -->\s*<aside class="sidebar">/;
const newBody = `<body>
    <!-- Top Navigation -->
    <header class="w-full h-16 bg-blue-900 text-white flex items-center px-6 shadow-md z-50 shrink-0">
        <div class="flex items-center gap-3">
            <i data-lucide="brain-circuit" class="w-6 h-6 text-blue-400"></i>
            <span class="text-xl font-bold tracking-tight font-sans">Socratoys Admin</span>
        </div>
        <nav class="flex gap-8 ml-10 h-full">
            <button class="nav-tab opacity-100 text-white font-medium text-sm flex items-center gap-2 h-full border-b-2 border-blue-400 transition-all" id="tab-analytics" onclick="switchTab('analytics')">
                <i data-lucide="bar-chart-2" class="w-4 h-4"></i> Analytics
            </button>
            <button class="nav-tab opacity-60 hover:opacity-100 text-white font-medium text-sm flex items-center gap-2 h-full border-b-2 border-transparent transition-all" id="tab-prompts" onclick="switchTab('prompts')">
                <i data-lucide="terminal" class="w-4 h-4"></i> Prompt Tuning
            </button>
        </nav>
    </header>

    <div class="w-full relative flex-1" style="height: calc(100vh - 64px);">
        
        <!-- View 1: Analytics -->
        <div id="view-analytics" class="w-full h-full flex bg-slate-50 absolute inset-0 z-10 transition-opacity">
            <aside class="sidebar">`;

html = html.replace(bodyRegex, newBody);

// 3. Add Prompt View right before <script>
const scriptRegex = /<\/main>\s*<script>/;
const promptView = `    </main>
        </div>

        <!-- View 2: Prompt Engine -->
        <div id="view-prompts" class="w-full h-full flex bg-slate-50 absolute inset-0 opacity-0 pointer-events-none z-0 transition-opacity">
            
            <!-- Left Side: Prompt Editor -->
            <div class="w-1/2 h-full flex flex-col border-r border-slate-200 bg-white">
                <div class="p-6 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                    <div>
                        <h2 class="text-lg font-bold text-slate-800 font-sans flex items-center gap-2"><i data-lucide="code-2" class="w-5 h-5 text-blue-600"></i> Agent Prompt Compiler</h2>
                        <p class="text-xs text-slate-500 font-mono mt-1">Select an agent to modify its core operational instructions.</p>
                    </div>
                    <select id="agent-select" class="bg-white border text-sm font-semibold text-slate-700 border-slate-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 shadow-sm" onchange="loadEditorPrompt()">
                        <option value="router">Initial Chat (Router)</option>
                        <option value="knowledge">Knowledge Explorer</option>
                        <option value="brainstorm">Brainstorming Coach</option>
                    </select>
                </div>
                
                <div class="flex-1 p-6 flex flex-col overflow-hidden relative">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider" id="editor-version">Version --</span>
                        <div class="flex gap-2 text-xs font-mono text-slate-400">
                            <i data-lucide="info" class="w-4 h-4"></i> Plain text markdown
                        </div>
                    </div>
                    <textarea id="prompt-textarea" class="w-full flex-1 p-4 bg-slate-900 text-slate-100 font-mono text-sm leading-relaxed rounded-lg border focus:ring-4 focus:ring-blue-100 outline-none resize-none shadow-inner" spellcheck="false" placeholder="Loading prompt..."></textarea>
                </div>
                
                <div class="p-6 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
                    <span class="text-xs font-mono text-emerald-600 hidden flex items-center gap-1" id="save-success"><i data-lucide="check-circle" class="w-4 h-4"></i> Saved & Deployed to Fleet</span>
                    <button class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-lg shadow transition-all focus:ring-4 focus:ring-blue-200 flex items-center gap-2 ml-auto" onclick="deployPrompt()">
                        <i data-lucide="rocket" class="w-4 h-4"></i> Deploy New Revision
                    </button>
                </div>
            </div>

            <!-- Right Side: Feedback Logs -->
            <div class="w-1/2 h-full flex flex-col bg-slate-50">
                <div class="p-6 border-b border-slate-200 bg-white">
                    <h2 class="text-lg font-bold text-amber-900 font-sans flex items-center gap-2"><i data-lucide="zap" class="w-5 h-5 text-amber-500"></i> AI Engagement Insights</h2>
                    <p class="text-xs text-slate-500 font-mono mt-1">Automatic improvement suggestions extracted from poor-performing sessions.</p>
                </div>
                <div class="flex-1 p-6 overflow-y-auto" id="suggestions-list">
                    <!-- Cards injected here -->
                </div>
            </div>

        </div>

    </div>

    <script>`;

html = html.replace(scriptRegex, promptView);

// 4. Add Javascript logic
const scriptAppend = `

        // --- View Switching ---
        function switchTab(viewName) {
            document.getElementById('tab-analytics').className = "nav-tab opacity-60 hover:opacity-100 text-white font-medium text-sm flex items-center gap-2 h-full border-b-2 border-transparent transition-all";
            document.getElementById('tab-prompts').className = "nav-tab opacity-60 hover:opacity-100 text-white font-medium text-sm flex items-center gap-2 h-full border-b-2 border-transparent transition-all";
            
            document.getElementById('view-analytics').classList.add('opacity-0', 'pointer-events-none');
            document.getElementById('view-analytics').classList.remove('z-10');
            document.getElementById('view-prompts').classList.add('opacity-0', 'pointer-events-none');
            document.getElementById('view-prompts').classList.remove('z-10');

            document.getElementById('tab-' + viewName).className = "nav-tab opacity-100 text-white font-medium text-sm flex items-center gap-2 h-full border-b-2 border-blue-400 transition-all";
            document.getElementById('view-' + viewName).classList.remove('opacity-0', 'pointer-events-none');
            document.getElementById('view-' + viewName).classList.add('z-10');
            
            if(viewName === 'prompts') {
                loadPromptEngine();
            }
        }

        // --- Prompt Engine Logic ---
        let loadedPrompts = [];
        
        async function loadPromptEngine() {
            try {
                // Fetch Prompts
                const pRes = await fetch('/api/prompts');
                const pData = await pRes.json();
                if(pData.success) {
                    loadedPrompts = pData.prompts;
                    loadEditorPrompt();
                }

                // Fetch Suggestions
                const sRes = await fetch('/api/suggestions');
                const sData = await sRes.json();
                if(sData.success) {
                    renderSuggestions(sData.suggestions);
                }
            } catch(e) { console.error(e); }
        }

        function loadEditorPrompt() {
            const agentId = document.getElementById('agent-select').value;
            const prompt = loadedPrompts.find(p => p.agent_id === agentId);
            const ta = document.getElementById('prompt-textarea');
            const vLabel = document.getElementById('editor-version');
            
            if(prompt) {
                ta.value = prompt.prompt_text;
                vLabel.textContent = "Version " + prompt.version;
            } else {
                ta.value = "No prompt found for this agent.";
                vLabel.textContent = "Version 0";
            }
        }

        async function deployPrompt() {
            const agentId = document.getElementById('agent-select').value;
            const text = document.getElementById('prompt-textarea').value;
            try {
                const res = await fetch('/api/prompts/' + agentId, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ prompt_text: text })
                });
                const data = await res.json();
                if(data.success) {
                    // Flash success
                    const succ = document.getElementById('save-success');
                    succ.classList.remove('hidden');
                    setTimeout(() => succ.classList.add('hidden'), 3000);
                    
                    // Reload active cache
                    loadPromptEngine();
                } else {
                    alert("Failed to save: " + data.error);
                }
            } catch(e) { console.error(e); alert("Failed to deploy!"); }
        }

        function renderSuggestions(suggestions) {
            const list = document.getElementById('suggestions-list');
            list.innerHTML = '';
            
            if(suggestions.length === 0) {
                list.innerHTML = '<div class="empty-state"><i data-lucide="check-circle-2" class="w-12 h-12 text-emerald-200"></i><span class="text-slate-400">No suggestions yet. Agents are performing well!</span></div>';
                lucide.createIcons();
                return;
            }

            suggestions.forEach(s => {
                const div = document.createElement('div');
                div.className = "bg-white border border-slate-200 rounded-lg p-5 mb-4 shadow-sm hover:shadow-md transition-shadow";
                div.innerHTML = \`
                    <div class="flex justify-between items-start mb-3">
                        <span class="badge badge-purple">\${s.topic || 'Any Topic'}</span>
                        <span class="text-xs font-mono text-slate-400">\${new Date(s.created_at || Date.now()).toLocaleDateString()}</span>
                    </div>
                    <p class="text-sm text-slate-700 font-sans leading-relaxed">\${s.prompt_improvement_suggestion}</p>
                    <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs font-mono text-slate-500">
                        <span class="flex items-center gap-1"><i data-lucide="target" class="w-3 h-3 \${s.engagement_score < 5 ? 'text-red-400' : 'text-amber-400'}"></i> Score: \${s.engagement_score}/10</span>
                        <span>LLM Generated</span>
                    </div>
                \`;
                list.appendChild(div);
            });
            lucide.createIcons();
        }

        // Init
        loadSessions();`;

html = html.replace('// Init\n        loadSessions();', scriptAppend);

fs.writeFileSync('admin.html', html);
console.log("Admin Dashboard Patched");
