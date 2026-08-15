(function(){
    'use strict';

    const canvasNodeId = new URLSearchParams(location.search).get('canvasNode') || '';
    const DETAIL_STORAGE_KEY = canvasNodeId ? `studio_main_image_canvas_${canvasNodeId}_draft_v1` : 'studio_main_image_draft_v1';
    const LEGACY_STORAGE_KEY = canvasNodeId ? '' : 'studio_detail_page_draft_v2';
    const DETAIL_PRESET_KEY = 'studio_main_image_preset_v1';
    const LEGACY_PRESET_KEY = 'studio_detail_page_preset_v2';
    const MAX_SOURCE_IMAGES = 6;
    const MAX_GROUP_CONCURRENCY = 3;

    const state = {
        products: [],
        references: Array(6).fill(null),
        providers: [],
        provider: '',
        model: '',
        chatProvider: '',
        chatModel: '',
        groups: [],
        groupSerial: 0,
        viewCount: 8,
        sortAscending: true,
        activeGroupId: '',
        editing: null,
        controlsCollapsed: false,
        renamingGroupId: '',
        cardReferenceTarget: null,
        collageGroupId: '',
        collageObjectUrl: '',
        collageFilename: '',
        assetPicker: {
            mode: 'products',
            referenceIndex: -1,
            source: 'library',
            libraryId: '',
            categoryId: '',
            query: '',
            libraries: [],
            libraryItems: [],
            localItems: [],
            selectedIds: new Set(),
            loading: false,
            error: ''
        }
    };

    let draftSaveTimer = null;
    let lightboxItems = [];
    let lightboxIndex = 0;
    let loadingTicker = null;
    let draggedCard = null;

    const $ = id => document.getElementById(id);
    const tr = key => window.StudioI18n ? StudioI18n.t(key) : key;
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const uid = () => `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    if(window.StudioI18n){
        StudioI18n.register({
            'detail.ready':{zh:'主图工作台',en:'Main image workspace'},
            'detail.title':{zh:'一键主图',en:'One-click Main Images'},
            'detail.subtitle':{zh:'使用当前自由接口批量生成连续主图或创意主图。',en:'Generate continuous or creative ecommerce images with the configured APIs.'},
            'detail.downloadAll':{zh:'下载全部结果',en:'Download all results'},
            'detail.downloadAllShort':{zh:'下载全部',en:'Download all'},
            'detail.productImage':{zh:'上传产品图',en:'Upload product images'},
            'detail.productImageHint':{zh:'拖入图片，或点击选择，合计最多 6 张',en:'Drop or choose images, up to 6 total'},
            'detail.size':{zh:'分辨率',en:'Resolution'},
            'detail.model':{zh:'模型标识',en:'Model'},
            'detail.quality':{zh:'质量',en:'Quality'},
            'detail.fontProtection':{zh:'字体保护',en:'Font protection'},
            'detail.fontProtectionHint':{zh:'尽量避免乱码与错字',en:'Reduce garbled or incorrect text'},
            'detail.output':{zh:'生成结果',en:'Generated results'},
            'detail.clear':{zh:'清空结果',en:'Clear results'},
            'detail.openApiSettings':{zh:'配置 API',en:'Configure API'}
        });
    }

    function applyLanguage(){
        const title = tr('detail.title');
        document.title = !title || title === 'detail.title' ? '一键主图' : title;
    }

    async function responseData(response){
        const text = await response.text();
        if(!text) return {};
        try { return JSON.parse(text); }
        catch(error){ return {detail:text.replace(/\s+/g, ' ').trim().slice(0, 500)}; }
    }

    function providerProtocol(provider){
        const proto = String(provider?.protocol || '').toLowerCase();
        const id = String(provider?.id || '').toLowerCase();
        const base = String(provider?.base_url || '').toLowerCase();
        if(proto === 'runninghub' || id === 'runninghub' || base.includes('runninghub')) return 'runninghub';
        return proto || 'openai';
    }

    function providerModels(provider){
        const models = Array.isArray(provider?.image_models) ? provider.image_models : [];
        return [...new Set(models.map(item => String(item || '').trim()).filter(Boolean))];
    }

    function providerChatModels(provider){
        const models = Array.isArray(provider?.chat_models) ? provider.chat_models : [];
        return [...new Set(models.map(item => String(item || '').trim()).filter(Boolean))];
    }

    function runningHubEntryId(entry, kind){
        if(!entry || typeof entry !== 'object') return '';
        const raw = kind === 'workflow' ? (entry.workflowId || entry.id) : (entry.appId || entry.webappId || entry.id);
        return String(raw || '').trim();
    }

    function runningHubEntries(provider){
        const models = providerModels(provider).map(model => ({kind:'model', id:model, title:model}));
        const collect = (list, kind) => (list || [])
            .filter(item => item && item.enabled !== false && item.hidden !== true)
            .map(item => ({kind, id:runningHubEntryId(item, kind), title:String(item.title || item.name || item.note || '').trim()}))
            .filter(item => item.id);
        return [...models, ...collect(provider?.rh_workflows, 'workflow'), ...collect(provider?.rh_apps, 'app')];
    }

    function providerCanGenerateImages(provider){
        if(!provider || provider.enabled === false) return false;
        if(providerModels(provider).length || provider.rh_apps?.length || provider.rh_workflows?.length) return true;
        return ['volcengine','jimeng','codex','gemini-cli'].includes(providerProtocol(provider));
    }

    function providerCanChat(provider){
        if(!provider || provider.enabled === false) return false;
        return providerChatModels(provider).length > 0 || ['codex','gemini-cli'].includes(providerProtocol(provider));
    }

    function renderProviders(){
        const enabled = state.providers.filter(providerCanGenerateImages);
        if(!state.provider || !enabled.some(item => item.id === state.provider)) state.provider = enabled[0]?.id || '';
        $('providerSelect').innerHTML = enabled.length
            ? enabled.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')
            : '<option value="">未配置图片接口</option>';
        $('providerSelect').value = state.provider;
        renderModels();
        $('providerBadge').textContent = enabled.find(item => item.id === state.provider)?.name || 'API';
    }

    function renderModels(){
        const provider = state.providers.find(item => item.id === state.provider);
        if(providerProtocol(provider) === 'runninghub'){
            const entries = runningHubEntries(provider);
            const keys = entries.map(item => item.kind === 'model' ? item.id : `${item.kind}:${item.id}`);
            if(!keys.includes(state.model)) state.model = keys[0] || '';
            $('modelSelect').innerHTML = entries.length
                ? entries.map(item => {
                    const key = item.kind === 'model' ? item.id : `${item.kind}:${item.id}`;
                    const tag = item.kind === 'model' ? '模型 API' : item.kind === 'workflow' ? '工作流' : 'AI 应用';
                    return `<option value="${esc(key)}">${esc(`[${tag}] ${item.title || item.id}`)}</option>`;
                }).join('')
                : '<option value="">未配置工作流或应用</option>';
            $('modelSelect').value = state.model;
            return;
        }
        const models = providerModels(provider);
        if(!state.model || !models.includes(state.model)) state.model = models[0] || '';
        $('modelSelect').innerHTML = models.length
            ? models.map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('')
            : '<option value="">使用平台默认模型</option>';
        $('modelSelect').value = state.model;
    }

    function renderChatProviders(){
        const enabled = state.providers.filter(providerCanChat);
        const currentImageProvider = enabled.find(item => item.id === state.provider);
        if(!state.chatProvider || !enabled.some(item => item.id === state.chatProvider)){
            state.chatProvider = currentImageProvider?.id || enabled[0]?.id || '';
        }
        $('chatProviderSelect').innerHTML = enabled.length
            ? enabled.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')
            : '<option value="">未配置聊天接口</option>';
        $('chatProviderSelect').value = state.chatProvider;
        renderChatModels();
    }

    function renderChatModels(){
        const provider = state.providers.find(item => item.id === state.chatProvider);
        const models = providerChatModels(provider);
        if(!state.chatModel || !models.includes(state.chatModel)) state.chatModel = models[0] || '';
        $('chatModelSelect').innerHTML = models.length
            ? models.map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('')
            : `<option value="">${provider ? '使用平台默认聊天模型' : '无可用聊天模型'}</option>`;
        $('chatModelSelect').value = state.chatModel;
    }

    async function loadProviders(){
        try {
            const response = await fetch('/api/providers');
            const data = await responseData(response);
            if(!response.ok) throw new Error(data.detail || '接口列表加载失败');
            state.providers = Array.isArray(data.providers) ? data.providers : [];
            renderProviders();
            renderChatProviders();
            refreshGroups();
        } catch(error){
            $('providerBadge').textContent = 'API';
            setStatus('接口列表加载失败，请检查服务状态。', true, true);
        }
    }

    function isApiConfigError(message){
        return /API ?Key|未配置|接口配置|Base URL|模型名称不能为空|未配置图片接口|平台不存在/i.test(String(message || ''));
    }

    function setStatus(message, isError=false, forceApiAction=false){
        const el = $('statusText');
        el.textContent = message || '';
        el.classList.toggle('error', Boolean(isError));
        const action = $('openApiSettingsBtn');
        if(action) action.hidden = !(forceApiAction || (isError && isApiConfigError(message)));
    }

    function openApiSettings(){
        try {
            const host = window.parent;
            const nav = host.document.querySelector('.side-pill[onclick*="api-settings"], .nav-item[onclick*="api-settings"]');
            if(typeof host.switchUI === 'function'){
                host.switchUI(nav, 'api-settings');
                return;
            }
            host.location.hash = 'api-settings';
        } catch(error) {}
    }

    function sourceCount(){
        return state.products.length + state.references.filter(Boolean).length;
    }

    function selectedRefs(){
        return [
            ...state.products.map(item => ({...item, role:'product'})),
            ...state.references.filter(Boolean).map(item => ({...item, role:'reference'}))
        ].slice(0, MAX_SOURCE_IMAGES);
    }

    function renderProducts(){
        const hasProducts = state.products.length > 0;
        $('productEmpty').hidden = hasProducts;
        $('productGrid').hidden = !hasProducts;
        $('clearProductBtn').hidden = !hasProducts;
        $('productGrid').innerHTML = state.products.map((item, index) => `
            <div class="product-item">
                <img src="${esc(item.url)}" alt="产品图 ${index + 1}">
                <span>${String(index + 1).padStart(2,'0')}</span>
                <button type="button" data-remove-product="${index}" title="移除这张产品图"><i data-lucide="x"></i></button>
            </div>
        `).join('');
        $('continueAddBtn').disabled = sourceCount() >= MAX_SOURCE_IMAGES;
        window.lucide?.createIcons();
    }

    function renderReferences(){
        const total = sourceCount();
        const hasReferences = state.references.some(Boolean);
        $('referenceGrid').classList.toggle('empty', !hasReferences);
        document.querySelectorAll('.reference-slot').forEach((slot, index) => {
            const item = state.references[index];
            const disabled = !item && total >= MAX_SOURCE_IMAGES;
            slot.classList.toggle('disabled', disabled);
            slot.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            slot.innerHTML = !hasReferences && index === 0
                ? `<i data-lucide="image-plus"></i><strong>参考图（设计风格参考）</strong><small>风格、配色、版式参考，与产品图合计最多 6 张</small>`
                : item
                ? `<img src="${esc(item.url)}" alt="参考图 ${index + 1}"><button class="ref-remove" type="button" title="移除"><i data-lucide="x"></i></button><span>${String(index + 1).padStart(2,'0')}</span>`
                : `<i data-lucide="${disabled ? 'lock' : 'plus'}"></i><span>${String(index + 1).padStart(2,'0')}</span>`;
        });
        window.lucide?.createIcons();
    }

    async function uploadFiles(files){
        const list = [...files].filter(file => file?.type?.startsWith('image/'));
        if(!list.length) return [];
        const form = new FormData();
        list.forEach(file => form.append('files', file));
        const response = await fetch('/api/ai/upload', {method:'POST', body:form});
        const data = await responseData(response);
        if(!response.ok) throw new Error(data.detail || '素材上传失败');
        return Array.isArray(data.files) ? data.files.filter(item => item?.url) : [];
    }

    async function chooseProducts(fileList){
        const files = [...(fileList || [])];
        if(!files.length) return;
        const available = MAX_SOURCE_IMAGES - sourceCount();
        if(available <= 0){
            setStatus(`产品图与参考图合计最多 ${MAX_SOURCE_IMAGES} 张。`, true);
            return;
        }
        const selected = files.slice(0, available);
        try {
            setStatus(`正在上传 ${selected.length} 张产品图...`);
            const uploaded = await uploadFiles(selected);
            state.products.push(...uploaded);
            renderProducts();
            renderReferences();
            setStatus(`产品图已就绪，共 ${state.products.length} 张。`);
            scheduleDraftSave();
        } catch(error){
            setStatus(error.message || '产品图上传失败。', true);
        }
    }

    async function chooseReference(index, file){
        if(!file) return;
        const replacing = Boolean(state.references[index]);
        if(!replacing && sourceCount() >= MAX_SOURCE_IMAGES){
            setStatus(`产品图与参考图合计最多 ${MAX_SOURCE_IMAGES} 张。`, true);
            return;
        }
        try {
            setStatus(`正在上传参考图 ${index + 1}...`);
            const uploaded = await uploadFiles([file]);
            if(!uploaded[0]) throw new Error('参考图上传失败');
            state.references[index] = uploaded[0];
            renderProducts();
            renderReferences();
            setStatus('参考图已就绪。');
            scheduleDraftSave();
        } catch(error){
            setStatus(error.message || '参考图上传失败。', true);
        }
    }

    function isAssetPickerImage(item){
        const kind = String(item?.kind || item?.type || '').toLowerCase();
        const url = String(item?.url || '').toLowerCase();
        if(kind && kind !== 'image') return false;
        return !/\.(mp4|webm|mov|m4v|avi|mkv|mp3|wav|flac|ogg|m4a|aac|json|zip)(\?|#|$)/.test(url);
    }

    function normalizeAssetPickerItem(item, source, libraryName='', categoryName='', libraryId='', categoryId=''){
        if(!item?.url || !isAssetPickerImage(item)) return null;
        const id = String(item.id || item.file || item.url);
        return {
            ...item,
            pickerId: `${source}:${libraryId || ''}:${categoryId || ''}:${id}`,
            source,
            libraryId,
            categoryId,
            libraryName,
            categoryName,
            name: String(item.name || item.file || '未命名素材'),
            url: String(item.url)
        };
    }

    function assetPickerLibraries(data){
        const raw = data?.library || {};
        const libraries = Array.isArray(raw.libraries) && raw.libraries.length
            ? raw.libraries
            : [{id:'default', name:'默认素材库', categories:Array.isArray(raw.categories) ? raw.categories : []}];
        return libraries.filter(item => item && item.id);
    }

    function assetPickerLibraryItems(libraries){
        return libraries.flatMap(library => (library.categories || [])
            .filter(category => (category.type || 'image') === 'image')
            .flatMap(category => (category.items || [])
                .map(item => normalizeAssetPickerItem(item, 'library', library.name || '素材库', category.name || '未分组', library.id, category.id))
                .filter(Boolean)));
    }

    function assetPickerCurrentItems(){
        const picker = state.assetPicker;
        const query = picker.query.trim().toLowerCase();
        let items = picker.source === 'local' ? picker.localItems : picker.libraryItems;
        if(picker.source === 'library' && picker.libraryId){
            items = items.filter(item => item.libraryId === picker.libraryId || item.pickerId.startsWith(`library:${picker.libraryId}:`));
        }
        if(picker.source === 'library' && picker.categoryId){
            items = items.filter(item => item.categoryId === picker.categoryId || item.pickerId.includes(`:${picker.categoryId}:`));
        }
        if(query){
            items = items.filter(item => [item.name, item.url, item.libraryName, item.categoryName].join(' ').toLowerCase().includes(query));
        }
        return items;
    }

    function assetPickerItemUsed(item){
        return [...state.products, ...state.references.filter(Boolean)].some(source => source?.url === item?.url);
    }

    function renderAssetPickerFilters(){
        const picker = state.assetPicker;
        document.querySelectorAll('[data-picker-source]').forEach(button => {
            const active = button.dataset.pickerSource === picker.source;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const librarySelect = $('assetPickerLibrary');
        const categorySelect = $('assetPickerCategory');
        const libraryMode = picker.source === 'library';
        librarySelect.disabled = !libraryMode;
        categorySelect.disabled = !libraryMode;
        if(!libraryMode){
            librarySelect.innerHTML = '<option value="">本地素材</option>';
            categorySelect.innerHTML = '<option value="">全部本地素材</option>';
            return;
        }
        librarySelect.innerHTML = picker.libraries.length
            ? picker.libraries.map(item => `<option value="${esc(item.id)}">${esc(item.name || '素材库')}</option>`).join('')
            : '<option value="">暂无素材库</option>';
        if(!picker.libraries.some(item => item.id === picker.libraryId)) picker.libraryId = picker.libraries[0]?.id || '';
        librarySelect.value = picker.libraryId;
        const currentLibrary = picker.libraries.find(item => item.id === picker.libraryId);
        const categories = (currentLibrary?.categories || []).filter(item => (item.type || 'image') === 'image');
        categorySelect.innerHTML = `<option value="">全部分组</option>${categories.map(item => `<option value="${esc(item.id)}">${esc(item.name || '未分组')}</option>`).join('')}`;
        if(!categories.some(item => item.id === picker.categoryId)) picker.categoryId = '';
        categorySelect.value = picker.categoryId;
    }

    function renderAssetPicker(){
        const picker = state.assetPicker;
        renderAssetPickerFilters();
        const grid = $('assetPickerGrid');
        const items = assetPickerCurrentItems();
        const available = Math.max(0, MAX_SOURCE_IMAGES - sourceCount());
        const maxSelected = picker.mode === 'reference' ? 1 : available;
        $('assetPickerStatus').textContent = picker.loading
            ? '正在读取素材库...'
            : picker.error || (items.length ? `${items.length} 个图片素材` : '当前筛选条件下没有图片素材');
        $('assetPickerSelection').textContent = picker.selectedIds.size
            ? `已选择 ${picker.selectedIds.size} 个`
            : picker.mode === 'reference' ? '请选择 1 张参考图' : `可再添加 ${available} 张`;
        $('assetPickerConfirm').disabled = picker.loading || picker.selectedIds.size === 0;
        if(!items.length){
            grid.innerHTML = picker.error
                ? '<div class="asset-picker-empty error"><i data-lucide="triangle-alert"></i><strong>素材库暂时不可用</strong><span>请检查本地服务状态后重试</span></div>'
                : '<div class="asset-picker-empty"><i data-lucide="images"></i><strong>暂无可选图片</strong><span>请先在素材库中导入图片素材</span></div>';
            window.lucide?.createIcons();
            return;
        }
        grid.innerHTML = items.map(item => {
            const selected = picker.selectedIds.has(item.pickerId);
            const used = picker.mode === 'products' && assetPickerItemUsed(item);
            const limitReached = !selected && picker.selectedIds.size >= maxSelected;
            const disabled = used || limitReached;
            return `<button class="asset-picker-item${selected ? ' selected' : ''}${used ? ' used' : ''}" type="button" data-picker-item="${esc(item.pickerId)}"${disabled ? ' disabled' : ''} aria-pressed="${selected ? 'true' : 'false'}">
                <span class="asset-picker-thumb"><img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy" decoding="async">${selected ? '<i data-lucide="check-circle-2"></i>' : ''}</span>
                <span class="asset-picker-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
                <span class="asset-picker-item-meta">${esc(item.source === 'local' ? (item.categoryName || '本地素材') : `${item.libraryName} / ${item.categoryName}`)}${used ? ' · 已添加' : ''}</span>
            </button>`;
        }).join('');
        window.lucide?.createIcons();
    }

    async function loadAssetPickerData(){
        const picker = state.assetPicker;
        picker.loading = true;
        picker.error = '';
        renderAssetPicker();
        try {
            const [libraryResponse, localResponse] = await Promise.all([
                fetch('/api/asset-library'),
                fetch('/api/local-assets')
            ]);
            const libraryData = await responseData(libraryResponse);
            const localData = await responseData(localResponse);
            if(!libraryResponse.ok) throw new Error(libraryData.detail || '素材库读取失败');
            if(!localResponse.ok) throw new Error(localData.detail || '本地素材读取失败');
            picker.libraries = assetPickerLibraries(libraryData);
            picker.libraryItems = assetPickerLibraryItems(picker.libraries);
            picker.localItems = (Array.isArray(localData.items) ? localData.items : [])
                .map(item => normalizeAssetPickerItem(item, 'local', '本地素材', item.folder || '全部本地素材', '', item.folder || ''))
                .filter(Boolean);
            picker.selectedIds = new Set([...picker.selectedIds].filter(id => [...picker.libraryItems, ...picker.localItems].some(item => item.pickerId === id)));
            if(!picker.libraryId || !picker.libraries.some(item => item.id === picker.libraryId)) picker.libraryId = picker.libraries[0]?.id || '';
            renderAssetPicker();
        } catch(error){
            picker.error = error.message || '素材库读取失败';
        } finally {
            picker.loading = false;
            renderAssetPicker();
        }
    }

    function openAssetPicker(mode='products', referenceIndex=-1){
        const picker = state.assetPicker;
        if(mode === 'products' && MAX_SOURCE_IMAGES - sourceCount() <= 0){
            setStatus(`产品图与参考图合计最多 ${MAX_SOURCE_IMAGES} 张。`, true);
            return;
        }
        if(mode === 'reference'){
            const index = referenceIndex >= 0 ? referenceIndex : state.references.findIndex(item => !item);
            if(index < 0 || (!state.references[index] && sourceCount() >= MAX_SOURCE_IMAGES)){
                setStatus(`产品图与参考图合计最多 ${MAX_SOURCE_IMAGES} 张。`, true);
                return;
            }
            picker.referenceIndex = index;
        } else picker.referenceIndex = -1;
        picker.mode = mode;
        picker.source = 'library';
        picker.libraryId = '';
        picker.categoryId = '';
        picker.query = '';
        picker.error = '';
        picker.selectedIds.clear();
        $('assetPickerTitle').textContent = mode === 'reference' ? '从素材库选择参考图' : '从素材库选择产品图';
        $('assetPickerHint').textContent = mode === 'reference' ? '选择 1 张图片回填到当前参考图位' : `可多选图片，最多补充 ${MAX_SOURCE_IMAGES - sourceCount()} 张`;
        $('assetPickerSearch').value = '';
        $('assetPickerModal').hidden = false;
        document.body.classList.add('asset-picker-open');
        renderAssetPicker();
        void loadAssetPickerData();
    }

    function closeAssetPicker(){
        $('assetPickerModal').hidden = true;
        document.body.classList.remove('asset-picker-open');
        state.assetPicker.selectedIds.clear();
    }

    function confirmAssetPicker(){
        const picker = state.assetPicker;
        const allItems = [...picker.libraryItems, ...picker.localItems];
        const selected = [...picker.selectedIds]
            .map(id => allItems.find(item => item.pickerId === id))
            .filter(Boolean);
        if(!selected.length) return;
        if(picker.mode === 'reference'){
            const item = selected[0];
            state.references[picker.referenceIndex] = {url:item.url, name:item.name, kind:'image', assetId:item.id, assetSource:item.source};
            renderProducts();
            renderReferences();
            setStatus('参考图已从素材库添加。');
        } else {
            const available = Math.max(0, MAX_SOURCE_IMAGES - sourceCount());
            const additions = selected.filter(item => !assetPickerItemUsed(item)).slice(0, available);
            state.products.push(...additions.map(item => ({url:item.url, name:item.name, kind:'image', assetId:item.id, assetSource:item.source})));
            renderProducts();
            renderReferences();
            setStatus(`已从素材库添加 ${additions.length} 张产品图。`);
        }
        scheduleDraftSave();
        closeAssetPicker();
    }

    async function chooseCardReference(file){
        const target = state.cardReferenceTarget;
        state.cardReferenceTarget = null;
        if(!file || !target) return;
        const group = findGroup(target.groupId);
        const card = group?.cards?.[target.cardIndex];
        if(!group || !card) return;
        const sources = cardSources(group, card);
        if(sources.length >= MAX_SOURCE_IMAGES){
            setStatus(`单张图片最多使用 ${MAX_SOURCE_IMAGES} 张参考图。`, true);
            return;
        }
        try {
            setStatus(`正在为第 ${target.cardIndex + 1} 屏上传参考图...`);
            const uploaded = await uploadFiles([file]);
            if(!uploaded[0]) throw new Error('参考图上传失败');
            card.sources = [...sources.map(item => ({...item})), {...uploaded[0], role:'reference'}].slice(0, MAX_SOURCE_IMAGES);
            refreshGroups();
            scheduleDraftSave();
            setStatus(`第 ${target.cardIndex + 1} 屏参考图已添加，单张重刷时生效。`);
        } catch(error){
            setStatus(error.message || '参考图上传失败。', true);
        }
    }

    function syncSizeOptions(preferred=''){
        const values = {
            wide:['1280x720','2048x1152','3840x2160'],
            portrait:['1024x1536','1360x2048','2352x3520'],
            portrait43:['1008x1344','1536x2048','2448x3264'],
            square:['1024x1024','2048x2048','3840x3840']
        }[$('ratioSelect').value] || ['1024x1024','2048x2048','3840x3840'];
        $('sizeSelect').innerHTML = values.map((value,index) => `<option value="${value}">${['1K','2K','4K'][index]}</option>`).join('');
        $('sizeSelect').value = values.includes(preferred) ? preferred : values[1];
    }

    function setGenerationMode(mode, persist=true){
        const value = mode === 'creative' ? 'creative' : 'continuous';
        if($('mainTypeSelect')) $('mainTypeSelect').value = value;
        document.querySelectorAll('#generationMode .mode-option').forEach(button => {
            const active = button.dataset.mode === value;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if(persist) scheduleDraftSave();
    }

    function formValues(){
        return {
            productName:$('productName').value.trim(),
            brandName:$('brandName').value.trim(),
            sellingPoints:$('sellingPoints').value.trim(),
            provider:state.provider,
            model:state.model,
            chatProvider:state.chatProvider,
            chatModel:state.chatModel,
            ratio:$('ratioSelect').value,
            ratioLabel:$('ratioSelect').selectedOptions[0]?.textContent || '1:1 方图',
            size:$('sizeSelect').value,
            quality:$('qualitySelect').value,
            count:Math.max(1, Math.min(8, Number($('countSelect').value) || 4)),
            mainType:$('mainTypeSelect').value === 'creative' ? 'creative' : 'continuous',
            copySetting:$('copySettingSelect').value,
            richness:$('styleSelect').value,
            fontStyle:$('fontStyleSelect').value,
            outputLanguage:$('outputLanguage').value.trim() || '中文',
            modelSettings:$('modelSettings').value,
            modelPose:$('modelPose').value,
            modelUsage:Math.max(1, Number($('modelUsage').value) || 1),
            fontProtection:$('fontProtection').checked,
            userPrompt:$('userPrompt').value.trim()
        };
    }

    function copyRule(config){
        if(config.copySetting === 'blank') return '不直接生成文字，保留明确、干净、可后期排版的文案留白区域。';
        if(config.copySetting === 'poster') return `使用${config.outputLanguage}生成极少量强视觉海报文案，只保留主标题与一个短卖点，不出现长段文字。`;
        return `使用${config.outputLanguage}生成少量准确、易读的电商文案，主标题简短，卖点清晰。`;
    }

    function richnessRule(value){
        return {
            classic:'经典电商构图，信息克制，主体明确，背景干净。',
            medium:'中等丰富度，加入适量场景、道具、光影和层次，但不要喧宾夺主。',
            rich:'丰富商业视觉，场景、光影、材质层次和装饰细节充分，同时保持商品是绝对主体。'
        }[value] || '经典电商构图，主体明确。';
    }

    function fontRule(config){
        const style = {auto:'根据商品与画面自动判断',modern:'现代无衬线',serif:'高级衬线',hand:'手写风格'}[config.fontStyle] || '自动判断';
        return config.fontProtection
            ? `字体风格为${style}。所有文字必须清晰、正确、可读，避免乱码、错字和过密小字。`
            : `字体风格为${style}，文字与画面统一。`;
    }

    function modelRule(config, index){
        if(config.modelSettings === 'none') return '不要使用模特或人物。';
        if(index >= Math.min(config.count, config.modelUsage)) return '本张不使用模特，让商品独立成为主体。';
        const pose = config.modelPose === 'special' ? '具有设计感的特殊姿态' : '自然、常规、可信的展示姿态';
        return `允许使用与商品定位匹配的模特，采用${pose}，模特不能遮挡商品关键结构。`;
    }

    function localPromptCards(config){
        const continuousPlans = [
            ['核心主视觉', '用最强主视觉建立商品认知，突出产品名称和第一核心利益点'],
            ['外观与设计', '展示商品整体轮廓、设计语言、颜色和关键结构'],
            ['核心卖点', '聚焦最重要的功能价值，用清晰视觉证据表达卖点'],
            ['细节与材质', '用近景和局部特写表现材质、工艺、纹理与品质'],
            ['真实场景', '放入最典型的真实使用环境，说明使用方式和适用人群'],
            ['规格与信息', '用规整、易读的信息布局承载尺寸、参数或使用说明'],
            ['对比与理由', '通过前后、场景或价值对比强化购买理由，避免贬低竞品'],
            ['收束海报', '以品牌感和完整商品形象收束整套主图，形成购买行动感']
        ];
        const creativePlans = [
            ['高点击封面', '做一张强对比、高识别度的独立广告封面'],
            ['场景创意', '用新颖但可信的使用场景制造记忆点'],
            ['材质冲击', '放大材质、工艺和光影质感，形成高级视觉'],
            ['卖点图形化', '把核心卖点转化为简洁、直观的视觉符号与构图'],
            ['极简棚拍', '使用极简商业摄影语言，让商品轮廓和颜色成为焦点'],
            ['人物故事', '以人物动作和情绪建立真实使用故事，同时保持商品清晰'],
            ['大胆版式', '使用更大胆的广告版式、裁切和色彩关系测试点击率'],
            ['品牌海报', '制作完整独立的品牌感海报，适合作为主图候选']
        ];
        const plans = config.mainType === 'creative' ? creativePlans : continuousPlans;
        const modeRule = config.mainType === 'creative'
            ? '这是创意主图系列中的独立封面，每张都必须能单独成立，构图和视觉创意可以明显不同，用于选图和测试点击率。'
            : `这是连续主图系列的第{{index}}张，共{{count}}张。所有图片必须保持同一商品、同一视觉系统和明确顺序，本张承担不同的信息任务。`;
        return Array.from({length:config.count}, (_, index) => {
            const [title, objective] = plans[index % plans.length];
            const userRule = config.userPrompt ? `最高优先级用户指令：${config.userPrompt}。如果与其他要求冲突，以这条用户指令为准。` : '';
            const product = config.productName || '参考产品图中的商品';
            const brand = config.brandName ? `品牌/店铺：${config.brandName}。` : '';
            const points = config.sellingPoints || '从产品图中准确判断真实特征，只表达可以由画面支持的卖点';
            const prompt = [
                modeRule.replace('{{index}}', String(index + 1)).replace('{{count}}', String(config.count)),
                `画面任务：${title}。${objective}。`,
                `商品：${product}。${brand}产品特征与卖点：${points}。`,
                userRule,
                richnessRule(config.richness),
                copyRule(config),
                fontRule(config),
                modelRule(config, index),
                `输出比例：${config.ratioLabel}，分辨率目标：${config.size}。`,
                '严格保留所有产品图中的真实外观、颜色、材质、结构、比例、Logo位置和数量，不得擅自改款，不得添加竞品或无关商品。参考图仅用于风格、配色和版式，不得把参考图中的其他商品替换为目标商品。商业摄影与平面设计结合，边缘干净，主体完整，适合淘宝、天猫或亚马逊主图直接使用。'
            ].filter(Boolean).join('');
            return {title, prompt};
        });
    }

    function chatTarget(preferred={}){
        const preferredProviderId = preferred.provider || state.chatProvider;
        const selected = state.providers.find(item => item.id === preferredProviderId);
        const currentImageProvider = state.providers.find(item => item.id === state.provider);
        const provider = providerCanChat(selected)
            ? selected
            : providerCanChat(currentImageProvider)
                ? currentImageProvider
                : state.providers.find(providerCanChat);
        if(!provider) return null;
        const models = providerChatModels(provider);
        const requestedModel = preferred.model || (provider.id === state.chatProvider ? state.chatModel : '');
        return {provider:provider.id, model:models.includes(requestedModel) ? requestedModel : (models[0] || requestedModel || '')};
    }

    async function requestChat(message, systemPrompt, referenceImages=[], signal, preferredTarget={}){
        const target = chatTarget(preferredTarget);
        if(!target) throw new Error('没有可用的文本模型');
        const response = await fetch('/api/chat', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                message,
                system_prompt:systemPrompt,
                provider:target.provider,
                model:target.model,
                reference_images:referenceImages,
                mode:'chat'
            }),
            signal
        });
        const data = await responseData(response);
        if(!response.ok) throw new Error(data.detail || '提示词分析接口失败');
        const content = data.message?.content;
        if(!content) throw new Error('提示词分析接口返回了空内容');
        return String(content).trim();
    }

    function parsePromptCards(raw, count){
        const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsed = null;
        try { parsed = JSON.parse(text); }
        catch(error){
            const first = text.indexOf('{');
            const last = text.lastIndexOf('}');
            if(first >= 0 && last > first){
                try { parsed = JSON.parse(text.slice(first, last + 1)); } catch(innerError) {}
            }
        }
        const source = Array.isArray(parsed) ? parsed : (parsed?.prompts || parsed?.items || parsed?.cards || []);
        const cards = Array.isArray(source) ? source.map((item, index) => {
            if(typeof item === 'string') return {title:`主图 ${index + 1}`, prompt:item.trim()};
            return {title:String(item?.title || item?.name || `主图 ${index + 1}`).trim(), prompt:String(item?.prompt || item?.content || '').trim()};
        }).filter(item => item.prompt) : [];
        return cards.slice(0, count);
    }

    async function analyzePrompts(group){
        const fallback = localPromptCards(group.config);
        const systemPrompt = [
            '你是资深电商主图策划和视觉导演。',
            `必须输出严格 JSON：{"prompts":[{"title":"短标题","prompt":"完整中文生图提示词"}]}，数组必须正好 ${group.config.count} 项。`,
            '不要输出 Markdown，不要解释，不要省略字段。',
            '用户指令拥有最高优先级。连续主图必须有顺序且每张承担不同卖点；创意主图必须每张都能独立作为封面。',
            '每条提示词都要重复产品一致性、文案、丰富度、字体、语言、模特、比例与参考图使用边界，确保单独提交也完整。'
        ].join('\n');
        const message = `请根据以下配置生成分段提示词：\n${JSON.stringify(group.config, null, 2)}`;
        try {
            const raw = await requestChat(message, systemPrompt, group.sources, group.controller.signal, {
                provider:group.config.chatProvider,
                model:group.config.chatModel
            });
            const parsed = parsePromptCards(raw, group.config.count);
            if(!parsed.length) throw new Error('文本模型没有返回可解析的分段提示词');
            const merged = Array.from({length:group.config.count}, (_, index) => parsed[index] || fallback[index]);
            group.analysisSource = 'AI 分析';
            group.analysisNotice = '';
            return merged;
        } catch(error){
            if(error?.name === 'AbortError') throw error;
            group.analysisSource = '本地规则';
            group.analysisNotice = `提示词分析未调用成功，已使用本地规则继续：${error.message || '未知错误'}`;
            return fallback;
        }
    }

    function providerName(providerId){
        return state.providers.find(item => item.id === providerId)?.name || providerId || 'API';
    }

    function createGroup(){
        const config = formValues();
        const serial = ++state.groupSerial;
        return {
            id:uid(),
            serial,
            title:`分组 #${serial}`,
            status:'analyzing',
            error:'',
            analysisSource:'',
            analysisNotice:'',
            startedAt:Date.now(),
            config,
            sources:selectedRefs().map(item => ({...item})),
            providerName:providerName(config.provider),
            cards:[],
            controller:new AbortController()
        };
    }

    function imageRequestBody(group, prompt, sources){
        return {
            prompt,
            provider_id:group.config.provider || state.provider || 'comfly',
            model:group.config.model || '',
            size:group.config.size || '2048x2048',
            quality:group.config.quality || 'auto',
            n:1,
            reference_images:Array.isArray(sources) ? sources : (group.sources || [])
        };
    }

    async function generateCard(group, card, signal){
        card.status = 'running';
        card.error = '';
        card.startedAt = Date.now();
        card.completedAt = 0;
        refreshGroups();
        try {
            const response = await fetch('/api/online-image', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify(imageRequestBody(group, card.prompt, card.sources || group.sources)),
                signal
            });
            const data = await responseData(response);
            if(!response.ok) throw new Error(data.detail || '接口生成失败');
            const url = Array.isArray(data.images) ? data.images.find(Boolean) : '';
            if(!url) throw new Error('接口没有返回图片');
            card.url = url;
            card.status = 'success';
        } catch(error){
            card.url = '';
            if(error?.name === 'AbortError'){
                card.status = 'canceled';
                card.error = '已取消';
            } else {
                card.status = 'error';
                card.error = error.message || '生成失败';
            }
        }
        card.completedAt = Date.now();
        refreshGroups();
        scheduleDraftSave();
    }

    async function runCardPool(group){
        let cursor = 0;
        const workers = Array.from({length:Math.min(MAX_GROUP_CONCURRENCY, group.cards.length)}, async () => {
            while(cursor < group.cards.length && !group.controller.signal.aborted){
                const index = cursor++;
                await generateCard(group, group.cards[index], group.controller.signal);
            }
        });
        await Promise.all(workers);
    }

    function recomputeGroupStatus(group){
        const success = group.cards.filter(card => card.status === 'success').length;
        const running = group.cards.some(card => ['pending','running'].includes(card.status));
        if(running){ group.status = 'running'; return; }
        if(group.controller?.signal?.aborted){ group.status = 'canceled'; return; }
        if(success === group.cards.length && success > 0){ group.status = 'success'; group.error = ''; return; }
        if(success > 0){ group.status = 'partial'; group.error = `${group.cards.length - success} 张生成失败`; return; }
        group.status = 'error';
        group.error = group.cards.find(card => card.error)?.error || '本组生成失败';
    }

    async function runGroup(group){
        syncGenerateButton();
        try {
            const prompts = await analyzePrompts(group);
            if(group.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            group.cards = prompts.map((item, index) => ({
                id:`${group.id}-card-${index + 1}`,
                title:item.title || `主图 ${index + 1}`,
                prompt:item.prompt,
                status:'pending',
                rerunning:false,
                url:'',
                error:'',
                startedAt:Date.now(),
                completedAt:0,
                selected:false,
                sources:null
            }));
            group.status = 'running';
            refreshGroups();
            syncGenerateButton();
            setStatus(`${group.title} 分析完成，开始生成 ${group.cards.length} 张主图。`);
            await runCardPool(group);
            recomputeGroupStatus(group);
            const success = group.cards.filter(card => card.status === 'success').length;
            setStatus(
                group.status === 'running' ? `${group.title} 批量任务已完成，单张重刷仍在进行。` :
                group.status === 'success' ? `${group.title} 已完成，共 ${success} 张。` :
                group.status === 'partial' ? `${group.title} 已完成 ${success} 张，部分图片失败。` :
                group.status === 'canceled' ? `${group.title} 已取消。` :
                `${group.title} 生成失败：${group.error}`,
                ['partial','error'].includes(group.status),
                isApiConfigError(group.error)
            );
        } catch(error){
            if(error?.name === 'AbortError'){
                group.status = 'canceled';
                group.error = '本组任务已取消。';
            } else {
                group.status = 'error';
                group.error = error.message || '分段提示词生成失败';
            }
        } finally {
            refreshGroups();
            syncGenerateButton();
            scheduleDraftSave();
        }
    }

    async function startGeneration(){
        if(sourceCount() === 0 && !$('productName').value.trim()){
            setStatus('请先上传至少一张产品图，或填写明确的产品名称。', true);
            return;
        }
        if(!state.provider){
            setStatus('请先配置可用的图片接口。', true, true);
            return;
        }
        const group = createGroup();
        state.groups.unshift(group);
        state.activeGroupId = group.id;
        refreshGroups();
        scheduleDraftSave();
        setStatus(`${group.title} 正在分析产品与参考图...`);
        void runGroup(group);
    }

    function syncGenerateButton(){
        const button = $('generatePromptBtn');
        button.disabled = false;
        button.classList.remove('busy');
        button.querySelector('span').textContent = '生成分段提示词';
    }

    function orderedGroups(){
        return state.sortAscending ? state.groups : [...state.groups].reverse();
    }

    function groupStatusText(group){
        const success = group.cards.filter(card => card.status === 'success').length;
        const finished = group.cards.filter(card => ['success','error','canceled'].includes(card.status)).length;
        if(group.status === 'analyzing') return '分析中';
        if(group.status === 'running') return `${finished}/${group.cards.length} 生成中`;
        if(group.status === 'success') return `${success} 张已完成`;
        if(group.status === 'partial') return `${success}/${group.cards.length} 张已完成`;
        if(group.status === 'canceled') return '已取消';
        return '生成失败';
    }

    function formatDuration(milliseconds){
        const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
        if(seconds < 60) return `${Math.max(1, seconds)} 秒`;
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
    }

    function averageGroupDuration(group){
        const completed = group.cards.filter(card => card.status === 'success' && Number(card.completedAt) > Number(card.startedAt));
        if(!completed.length) return '';
        const average = completed.reduce((sum, card) => sum + (Number(card.completedAt) - Number(card.startedAt)), 0) / completed.length;
        return `平均 ${formatDuration(average)}（${completed.length} 屏成功）`;
    }

    function resolutionLabel(size){
        const longest = String(size || '').split('x').map(Number).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0);
        if(longest >= 3000) return '4K';
        if(longest >= 1800) return '2K';
        return '1K';
    }

    function mediaRatio(config={}){
        const known = {
            wide:'16 / 9',
            portrait:'2 / 3',
            portrait43:'3 / 4',
            square:'1 / 1'
        }[config.ratio];
        if(known) return known;
        const match = String(config.size || '').match(/^\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*$/);
        if(!match) return '1 / 1';
        const width = Number(match[1]);
        const height = Number(match[2]);
        return width > 0 && height > 0 ? `${width} / ${height}` : '1 / 1';
    }

    function cardSources(group, card){
        return Array.isArray(card?.sources) ? card.sources : (group.sources || []);
    }

    function renderReferenceRail(group, card, index){
        const refs = cardSources(group, card).slice(0, MAX_SOURCE_IMAGES);
        const disabled = refs.length >= MAX_SOURCE_IMAGES;
        return `<div class="reference-rail">${refs.map(item => `<img src="${esc(item.url)}" alt="${item.role === 'product' ? '产品图' : '参考图'}">`).join('')}<button class="reference-add" type="button" data-card-action="add-reference" data-group-id="${esc(group.id)}" data-card-index="${index}" title="${disabled ? '单张参考图已达上限' : '添加本张参考图'}" ${disabled ? 'disabled' : ''}><i data-lucide="plus"></i></button></div>`;
    }

    function cardMarkup(group, card, index){
        const promptStatus = card.promptOptimization?.status || 'idle';
        const promptIcon = promptStatus === 'running' ? 'loader-circle' : promptStatus === 'ready' ? 'wand-sparkles' : promptStatus === 'error' ? 'triangle-alert' : 'message-square-plus';
        const promptTitle = promptStatus === 'running' ? '提示词优化中' : promptStatus === 'ready' ? '提示词已优化，点击查看' : promptStatus === 'error' ? '提示词优化失败，点击重试' : '提示词助手';
        let media = '';
        if(card.status === 'success' && card.url){
            media = `<img src="${esc(card.url)}" alt="${esc(card.title)}">`;
        } else if(['pending','running'].includes(card.status)){
            media = `<div class="card-loading"><span class="detail-spinner"></span><small data-wait-start="${Number(card.startedAt) || Date.now()}">已等待 0s</small></div>`;
        } else {
            media = `<div class="card-error-state"><i data-lucide="${card.status === 'canceled' ? 'circle-slash-2' : 'triangle-alert'}"></i><strong>${card.status === 'canceled' ? '已取消' : '生成失败'}</strong><small>${esc(card.error || '请重试')}</small></div>`;
        }
        const retryTool = card.rerunning
            ? '<button class="rerun-running" type="button" title="单张重刷中" disabled><i data-lucide="loader-circle"></i></button>'
            : !['pending','running'].includes(card.status)
                ? `<button type="button" data-card-action="retry" data-group-id="${esc(group.id)}" data-card-index="${index}" title="单张重刷"><i data-lucide="refresh-cw"></i></button>`
                : '';
        const tools = `
            <div class="output-tools">
                ${retryTool}
                ${card.url ? `<a href="${esc(card.url)}" download="分组-${group.serial}-${String(index + 1).padStart(2,'0')}.png" title="下载"><i data-lucide="download"></i></a>` : ''}
            </div>`;
        return `
            <div class="output-card ${esc(card.status)} prompt-${esc(promptStatus)} ${card.selected ? 'selected' : ''}" data-preview-card="${card.url ? 'true' : 'false'}" data-group-id="${esc(group.id)}" data-card-index="${index}">
                <div class="card-topline" draggable="true" data-card-drag data-group-id="${esc(group.id)}" data-card-index="${index}" title="按住左右拖动排序" aria-label="第 ${index + 1} 屏，按住左右拖动排序"><span>${String(index + 1).padStart(2,'0')}</span><i data-lucide="more-horizontal"></i></div>
                <div class="card-media">
                    <label class="card-select-control" title="${card.url ? '选择这张图片' : '生成完成后可选择'}"><input type="checkbox" data-card-select data-group-id="${esc(group.id)}" data-card-index="${index}" ${card.selected ? 'checked' : ''} ${card.url ? '' : 'disabled'}><span></span></label>
                    ${card.url ? `<button class="card-zoom" type="button" data-card-action="zoom" data-group-id="${esc(group.id)}" data-card-index="${index}" title="放大预览"><i data-lucide="zoom-in"></i></button>` : ''}
                    ${media}${tools}
                </div>
                <div class="card-caption"><div class="card-caption-copy"><strong>${esc(card.title)}</strong><span title="${esc(card.prompt)}">${esc(card.prompt)}</span></div><button class="prompt-tool ${esc(promptStatus)}" type="button" data-card-action="prompt" data-group-id="${esc(group.id)}" data-card-index="${index}" title="${esc(promptTitle)}"><i data-lucide="${promptIcon}"></i></button></div>
                ${renderReferenceRail(group, card, index)}
            </div>`;
    }

    function groupMarkup(group){
        const statusText = groupStatusText(group);
        const targetCount = group.config?.count || 0;
        const count = group.status === 'analyzing' ? 0 : (group.cards.length || targetCount);
        const modelLabel = `${group.providerName || providerName(group.config?.provider)}${group.config?.model ? ` · ${group.config.model}` : ''} · ${(group.config?.ratioLabel || '1:1').split(' ')[0]} · ${resolutionLabel(group.config?.size)} · ${group.config?.quality || 'auto'}`;
        const duration = averageGroupDuration(group);
        const successfulCards = group.cards.filter(card => card.status === 'success' && card.url);
        const selectedCards = successfulCards.filter(card => card.selected);
        const renaming = state.renamingGroupId === group.id;
        const groupName = group.title || `分组 #${group.serial}`;
        const titleMarkup = renaming
            ? `<input class="group-rename-input" data-group-rename-input data-group-id="${esc(group.id)}" value="${esc(groupName)}" aria-label="分组名称">`
            : `<strong class="group-name">${esc(groupName)}</strong><button class="group-rename" type="button" data-group-action="rename" data-group-id="${esc(group.id)}" title="重命名"><i data-lucide="pencil"></i></button>`;
        const body = group.status === 'analyzing'
            ? `<div class="group-analysis"><span class="detail-spinner"></span><strong>正在分析产品与参考图</strong><small>正在生成 ${targetCount} 段相互独立的主图提示词，分析完成后才会创建图片卡片。</small></div>`
            : `<div class="group-grid" style="--media-ratio:${mediaRatio(group.config)}">${group.cards.map((card, index) => cardMarkup(group, card, index)).join('') || `<div class="group-empty-error">${esc(group.error || '本组没有可显示的图片。')}</div>`}</div>`;
        const retryButton = ['error','partial','canceled'].includes(group.status)
            ? `<button class="retry-command" type="button" data-group-action="retry" data-group-id="${esc(group.id)}">重试本组</button>` : '';
        const configAction = group.status === 'error' && isApiConfigError(group.error)
            ? '<button class="configure-command" type="button" data-group-action="api" title="配置 API"><i data-lucide="settings-2"></i><span>配置 API</span></button>' : '';
        return `
            <article id="detail-${esc(group.id)}" class="result-group">
                <div class="group-header">
                    <div class="group-summary">
                        <div class="group-title">${titleMarkup}<small>${count} 屏</small><span class="group-status ${esc(group.status)}">${group.status === 'analyzing' ? '<i data-lucide="loader-circle"></i>' : ''}${esc(statusText)}</span>${duration ? `<span class="group-duration">${esc(duration)}</span>` : ''}${group.analysisSource ? `<span class="analysis-source">${esc(group.analysisSource)}</span>` : ''}</div>
                        <div class="group-meta"><span title="${esc(modelLabel)}">${esc(modelLabel)}</span><button class="group-switch-command" type="button" data-group-action="switch-model" data-group-id="${esc(group.id)}" title="切换本组后续生成模型"><i data-lucide="shuffle"></i><span>切换模型</span></button></div>
                    </div>
                    <div class="group-actions">
                        <button class="group-text-command" type="button" data-group-action="collage" data-group-id="${esc(group.id)}" ${successfulCards.length ? '' : 'disabled'}><i data-lucide="layout-grid"></i><span>拼图预览</span></button>
                        <button class="group-text-command" type="button" data-group-action="download" data-group-id="${esc(group.id)}" ${successfulCards.length ? '' : 'disabled'}><i data-lucide="download"></i><span>下载全部</span></button>
                        <button class="group-text-command" type="button" data-group-action="download-selected" data-group-id="${esc(group.id)}" ${selectedCards.length ? '' : 'disabled'}><i data-lucide="check"></i><span>下载选中${selectedCards.length ? ` (${selectedCards.length})` : ''}</span></button>
                        ${['analyzing','running'].includes(group.status) ? `<button class="group-cancel-command" type="button" data-group-action="cancel" data-group-id="${esc(group.id)}" title="取消本组"><i data-lucide="x"></i></button>` : ''}
                        ${configAction}${retryButton}
                        <button class="group-delete-command" type="button" data-group-action="delete" data-group-id="${esc(group.id)}" title="删除本组"><i data-lucide="trash-2"></i></button>
                    </div>
                </div>
                ${group.analysisNotice ? `<div class="analysis-notice">${esc(group.analysisNotice)}</div>` : ''}
                ${body}
            </article>`;
    }

    function renderGroupTabs(){
        const groups = orderedGroups();
        if(!state.activeGroupId || !state.groups.some(group => group.id === state.activeGroupId)) state.activeGroupId = groups[0]?.id || '';
        $('groupTabs').innerHTML = groups.map(group => `<button class="group-tab ${group.id === state.activeGroupId ? 'active' : ''}" type="button" data-group-tab="${esc(group.id)}" title="${esc(group.title || `分组 #${group.serial}`)}">${esc(group.title || `分组 #${group.serial}`)}</button>`).join('');
    }

    function refreshGroups(){
        const groups = orderedGroups();
        $('detailGroups').innerHTML = groups.length
            ? groups.map(groupMarkup).join('')
            : '<div id="emptyState" class="empty-state"><i data-lucide="layout-template"></i><strong>等待生成分段提示词</strong><span>右侧任务与图片卡片会在点击左侧“生成分段提示词”后创建。</span></div>';
        renderGroupTabs();
        const finished = state.groups.reduce((sum, group) => sum + group.cards.filter(card => card.status === 'success').length, 0);
        $('resultCount').textContent = `${finished} 张`;
        $('activeGroupLabel').textContent = state.groups.length ? `${state.groups.length} 个历史分组` : '未开始生成';
        document.querySelectorAll('.group-grid').forEach(grid => grid.style.setProperty('--group-columns', String(state.viewCount)));
        window.lucide?.createIcons();
    }

    function findGroup(id){
        return state.groups.find(group => group.id === id);
    }

    function syncControlsPanel(){
        const layout = document.querySelector('.detail-layout');
        const button = $('detailPanelToggle');
        layout?.classList.toggle('controls-collapsed', state.controlsCollapsed);
        if(button){
            const label = state.controlsCollapsed ? '展开参数栏' : '收起参数栏';
            button.title = label;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-expanded', state.controlsCollapsed ? 'false' : 'true');
            button.innerHTML = `<i data-lucide="${state.controlsCollapsed ? 'chevron-right' : 'chevron-left'}"></i>`;
        }
        window.lucide?.createIcons();
    }

    function abortGroupTasks(group){
        if(!group) return;
        group.controller?.abort?.();
        group.cards.forEach(card => {
            card.controller?.abort?.();
            card.controller = null;
        });
    }

    function cancelGroup(group){
        if(!group) return;
        abortGroupTasks(group);
        group.cards.forEach(card => {
            if(['pending','running'].includes(card.status)){
                card.status = 'canceled';
                card.error = '已取消';
            }
            card.rerunning = false;
        });
        group.status = 'canceled';
        group.error = '本组任务已取消。';
        refreshGroups();
        syncGenerateButton();
        scheduleDraftSave();
    }

    async function retryGroup(group){
        if(!group || ['analyzing','running'].includes(group.status)) return;
        if(!group.cards.length){
            group.controller = new AbortController();
            group.status = 'analyzing';
            group.error = '';
            refreshGroups();
            void runGroup(group);
            return;
        }
        group.controller = new AbortController();
        group.error = '';
        group.status = 'running';
        group.cards.forEach(card => { card.status = 'pending'; card.rerunning = false; card.url = ''; card.error = ''; card.startedAt = Date.now(); card.completedAt = 0; card.selected = false; });
        refreshGroups();
        syncGenerateButton();
        setStatus(`正在重试 ${group.title}...`);
        await runCardPool(group);
        recomputeGroupStatus(group);
        refreshGroups();
        syncGenerateButton();
        scheduleDraftSave();
        setStatus(
            group.status === 'running' ? `${group.title} 批量重试已完成，单张重刷仍在进行。` :
            group.status === 'success' ? `${group.title} 重试完成。` :
            `${group.title} 重试结束，仍有失败图片。`,
            !['running','success'].includes(group.status),
            isApiConfigError(group.error)
        );
    }

    function imageModelCandidates(){
        const result = [];
        state.providers.filter(providerCanGenerateImages).forEach(provider => {
            if(providerProtocol(provider) === 'runninghub'){
                runningHubEntries(provider).forEach(entry => result.push({
                    provider:provider.id,
                    providerName:provider.name || provider.id,
                    model:entry.kind === 'model' ? entry.id : `${entry.kind}:${entry.id}`
                }));
                return;
            }
            const models = providerModels(provider);
            if(models.length) models.forEach(model => result.push({provider:provider.id, providerName:provider.name || provider.id, model}));
            else result.push({provider:provider.id, providerName:provider.name || provider.id, model:''});
        });
        return result;
    }

    function switchGroupModel(group){
        const candidates = imageModelCandidates();
        if(!group || !candidates.length){ setStatus('没有其他可用的图片模型。', true, true); return; }
        const current = candidates.findIndex(item => item.provider === group.config.provider && item.model === group.config.model);
        const next = candidates[(current + 1 + candidates.length) % candidates.length];
        group.config.provider = next.provider;
        group.config.model = next.model;
        group.providerName = next.providerName;
        setStatus(`${group.title} 已切换到 ${next.providerName}${next.model ? ` · ${next.model}` : ''}，重刷时生效。`);
        refreshGroups();
        scheduleDraftSave();
    }

    function beginRenameGroup(group){
        if(!group) return;
        state.renamingGroupId = group.id;
        refreshGroups();
        requestAnimationFrame(() => {
            const input = document.querySelector(`[data-group-rename-input][data-group-id="${CSS.escape(group.id)}"]`);
            input?.focus();
            input?.select();
        });
    }

    function commitRenameGroup(group, value){
        if(!group) return;
        group.title = String(value || '').trim() || `分组 #${group.serial}`;
        state.renamingGroupId = '';
        scheduleDraftSave();
        refreshGroups();
    }

    function cancelRenameGroup(){
        if(!state.renamingGroupId) return;
        state.renamingGroupId = '';
        refreshGroups();
    }

    function releaseCollageObjectUrl(){
        if(state.collageObjectUrl){
            URL.revokeObjectURL(state.collageObjectUrl);
            state.collageObjectUrl = '';
        }
    }

    async function openCollage(group){
        const cards = group?.cards?.filter(card => card.status === 'success' && card.url) || [];
        if(!group || !cards.length){ setStatus('本组还没有可预览的图片。', true); return; }
        releaseCollageObjectUrl();
        state.collageGroupId = group.id;
        state.collageFilename = `${group.title || `分组-${group.serial}`}-完整长图.png`.replace(/[\\/:*?"<>|]+/g, '_');
        $('collageTitle').textContent = `${group.title || `分组 #${group.serial}`} · 拼图预览`;
        $('collageCount').textContent = `${cards.length} 张 · 正在合成长图`;
        $('collageDownload').disabled = true;
        $('collageGrid').innerHTML = '<div class="collage-loading"><span class="detail-spinner"></span><strong>正在合成完整长图</strong><small>图片会按当前顺序无缝纵向拼接</small></div>';
        $('collageModal').hidden = false;
        document.body.classList.add('collage-modal-open');
        window.lucide?.createIcons();
        try {
            const response = await fetch('/api/detail-page/collage', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({urls:cards.map(card => card.url), filename:state.collageFilename, max_width:2048})
            });
            if(!response.ok) throw new Error((await responseData(response)).detail || '长图合成失败');
            const blob = await response.blob();
            if(state.collageGroupId !== group.id) return;
            state.collageObjectUrl = URL.createObjectURL(blob);
            const width = Number(response.headers.get('X-Collage-Width')) || 0;
            const height = Number(response.headers.get('X-Collage-Height')) || 0;
            $('collageCount').textContent = `${cards.length} 张 · 已合并为 1 张${width && height ? ` · ${width}×${height}` : ''}`;
            $('collageGrid').innerHTML = `<img class="collage-sheet" src="${esc(state.collageObjectUrl)}" alt="${esc(group.title || '完整详情长图')}">`;
            $('collageDownload').disabled = false;
            setStatus(`${group.title || `分组 #${group.serial}`} 已合成为一张完整长图。`);
        } catch(error){
            if(state.collageGroupId !== group.id) return;
            $('collageCount').textContent = `${cards.length} 张 · 合成失败`;
            $('collageGrid').innerHTML = `<div class="collage-error"><i data-lucide="triangle-alert"></i><strong>长图合成失败</strong><span>${esc(error.message || '请稍后重试')}</span></div>`;
            setStatus(error.message || '长图合成失败。', true);
            window.lucide?.createIcons();
        }
    }

    function closeCollage(){
        $('collageModal').hidden = true;
        document.body.classList.remove('collage-modal-open');
        state.collageGroupId = '';
        state.collageFilename = '';
        $('collageDownload').disabled = true;
        releaseCollageObjectUrl();
    }

    function downloadCollage(){
        if(!state.collageObjectUrl) return;
        const link = document.createElement('a');
        link.href = state.collageObjectUrl;
        link.download = state.collageFilename || '完整详情长图.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    async function rerunCard(group, index){
        const card = group?.cards?.[index];
        if(!card) return;
        if(card.rerunning || ['pending','running'].includes(card.status)){
            setStatus('这张图片正在生成，请勿重复提交。', true);
            return;
        }
        if(group.controller?.signal?.aborted) group.controller = new AbortController();
        const controller = new AbortController();
        card.controller = controller;
        card.rerunning = true;
        card.status = 'running';
        card.url = '';
        card.error = '';
        card.startedAt = Date.now();
        card.completedAt = 0;
        card.selected = false;
        group.status = 'running';
        refreshGroups();
        syncGenerateButton();
        setStatus(`正在重刷 ${group.title} · ${card.title}...`);
        try {
            await generateCard(group, card, controller.signal);
        } finally {
            if(card.status === 'running'){
                card.status = 'error';
                card.error = card.error || '单张重刷异常终止';
                card.completedAt = Date.now();
            }
            card.rerunning = false;
            if(card.controller === controller) card.controller = null;
            recomputeGroupStatus(group);
            refreshGroups();
            syncGenerateButton();
            scheduleDraftSave();
        }
        setStatus(card.status === 'success' ? '单张重刷完成。' : `单张重刷失败：${card.error}`, card.status !== 'success', isApiConfigError(card.error));
    }

    function promptTask(card){
        if(!card.promptOptimization || typeof card.promptOptimization !== 'object'){
            card.promptOptimization = {status:'idle', sourcePrompt:'', instruction:'', result:'', message:'', error:'', taskId:'', startedAt:0};
        }
        return card.promptOptimization;
    }

    function editingContext(){
        const editing = state.editing;
        const group = editing ? findGroup(editing.groupId) : null;
        const card = group?.cards?.find(item => item.id === editing?.cardId) || group?.cards?.[editing?.cardIndex];
        const index = card && group ? group.cards.indexOf(card) : -1;
        return {editing, group, card, index};
    }

    function promptLength(value){
        return Array.from(String(value || '').trim()).length;
    }

    function updatePromptCounts(){
        $('promptCurrentCount').textContent = `当前 ${promptLength($('promptEditInput').value)} 字`;
        $('promptResultCount').textContent = `${promptLength($('promptEditResult').value)} 字`;
    }

    function syncPromptEditor(card, hydrate = false){
        if(!card) return;
        const task = promptTask(card);
        if(hydrate){
            $('promptEditInput').value = card.prompt || '';
            $('promptEditInstruction').value = task.instruction || '';
        }
        $('promptEditResult').value = task.result || '';
        const running = task.status === 'running';
        const ready = task.status === 'ready' && !!task.result;
        $('promptEditInput').disabled = running;
        $('promptEditInstruction').disabled = running;
        $('promptRestoreBtn').disabled = running;
        $('promptOptimizeBtn').disabled = running;
        $('promptApplyBtn').disabled = !ready;
        $('promptOptimizeBtn').classList.toggle('optimized', ready);
        $('promptOptimizeBtn').classList.toggle('running', running);
        $('promptOptimizeBtn').querySelector('span').textContent = running ? '优化中' : ready ? '重新优化' : '开始优化';
        $('promptOptimizeStatus').className = `prompt-optimize-status${task.status === 'ready' ? ' ready' : task.status === 'error' ? ' error' : ''}`;
        $('promptOptimizeStatus').textContent = running
            ? '正在优化提示词，关闭窗口后任务仍会继续。'
            : ready
                ? (task.message || '优化完成，可以采用并单张重刷。')
                : task.status === 'error'
                    ? (task.error || '提示词优化失败，请重试。')
                    : '';
        updatePromptCounts();
        window.lucide?.createIcons();
    }

    function openPromptEditor(group, index){
        const card = group?.cards?.[index];
        if(!card) return;
        promptTask(card);
        state.editing = {groupId:group.id, cardId:card.id, cardIndex:index};
        $('promptEditTitle').textContent = `优化第 ${index + 1} 屏提示词`;
        syncPromptEditor(card, true);
        $('promptEditModal').hidden = false;
        document.body.classList.add('prompt-modal-open');
    }

    function closePromptEditor(){
        $('promptEditModal').hidden = true;
        document.body.classList.remove('prompt-modal-open');
        state.editing = null;
    }

    async function optimizePrompt(){
        const {group, card} = editingContext();
        if(!group || !card) return;
        const current = $('promptEditInput').value.trim();
        const instruction = $('promptEditInstruction').value.trim();
        if(!instruction){
            $('promptOptimizeStatus').textContent = '请先填写优化要求。';
            $('promptOptimizeStatus').className = 'prompt-optimize-status error';
            return;
        }
        const taskId = uid();
        card.promptOptimization = {status:'running', sourcePrompt:current, instruction, result:'', message:'', error:'', taskId, startedAt:Date.now()};
        syncPromptEditor(card);
        refreshGroups();
        scheduleDraftSave();
        const systemPrompt = '你是电商主图提示词编辑器。严格遵守修改要求，保留未被修改的产品一致性、接口参数和参考图边界。只输出优化后的完整提示词，不要解释，不要使用 Markdown。';
        let optimized = '';
        let message = '优化完成，可以采用并单张重刷。';
        try {
            optimized = await requestChat(
                `当前提示词：\n${current}\n\n修改要求（最高优先级）：\n${instruction}`,
                systemPrompt,
                cardSources(group, card),
                undefined,
                {provider:group.config.chatProvider, model:group.config.chatModel}
            );
        } catch(error){
            optimized = `${current}\n最高优先级修改要求：${instruction}。必须严格执行这条修改要求，其余产品一致性、画面质量和参考图边界保持不变。`;
            message = `文本模型不可用，已用本地规则完成优化：${error.message || '未知错误'}`;
        }
        const liveGroup = findGroup(group.id);
        const liveCard = liveGroup?.cards?.find(item => item.id === card.id);
        if(!liveCard || liveCard.promptOptimization?.taskId !== taskId) return;
        liveCard.promptOptimization = {...liveCard.promptOptimization, status:'ready', result:String(optimized || '').trim(), message, error:''};
        refreshGroups();
        scheduleDraftSave();
        const currentEditing = editingContext();
        if(currentEditing.card?.id === liveCard.id) syncPromptEditor(liveCard);
    }

    async function applyOptimizedPrompt(){
        const {group, card, index} = editingContext();
        if(!group || !card || index < 0) return;
        const task = promptTask(card);
        const prompt = ($('promptEditResult').value || task.result).trim();
        if(!prompt) return;
        card.prompt = prompt;
        card.promptOptimization = {status:'idle', sourcePrompt:prompt, instruction:'', result:'', message:'', error:'', taskId:'', startedAt:0};
        closePromptEditor();
        scheduleDraftSave();
        await rerunCard(group, index);
    }

    async function downloadGroupItems(group, cards, suffix=''){
        const selected = Array.isArray(cards) ? cards : group?.cards;
        const items = (selected || []).map(card => {
            const index = group.cards.indexOf(card);
            return {url:card.url, name:`分组-${group.serial}-${String(index + 1).padStart(2,'0')}.png`};
        }).filter(item => item.url);
        if(!items.length) return;
        setStatus(`正在打包 ${group.title}...`);
        try {
            const filename = `分组-${group.serial}${suffix}.zip`;
            const response = await fetch('/api/canvas-assets/download', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename, items})});
            if(!response.ok) throw new Error((await responseData(response)).detail || '下载失败');
            const blob = await response.blob();
            const href = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = href;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(href), 1200);
            setStatus(`${group.title} 已下载 ${items.length} 张。`);
        } catch(error){ setStatus(error.message || '下载失败。', true); }
    }

    function downloadGroup(group){
        return downloadGroupItems(group, group?.cards || []);
    }

    function downloadSelectedGroup(group){
        const cards = group?.cards?.filter(card => card.selected && card.status === 'success' && card.url) || [];
        if(!cards.length){ setStatus('请先勾选要下载的图片。', true); return Promise.resolve(); }
        return downloadGroupItems(group, cards, '-选中');
    }

    async function downloadAll(){
        const items = state.groups.flatMap(group => group.cards.map((card, index) => ({url:card.url, name:`分组-${group.serial}-${String(index + 1).padStart(2,'0')}.png`}))).filter(item => item.url);
        if(!items.length){ setStatus('当前没有可下载的结果。', true); return; }
        setStatus(`正在打包 ${items.length} 张结果...`);
        try {
            const response = await fetch('/api/canvas-assets/download', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:`${$('productName').value.trim() || '一键主图'}-素材.zip`, items})});
            if(!response.ok) throw new Error((await responseData(response)).detail || '下载失败');
            const blob = await response.blob();
            const href = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = href;
            link.download = `${$('productName').value.trim() || '一键主图'}-素材.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(href), 1200);
            setStatus(`已下载 ${items.length} 张结果。`);
        } catch(error){ setStatus(error.message || '下载失败。', true); }
    }

    function clearResults(){
        state.groups.forEach(abortGroupTasks);
        state.groups = [];
        state.activeGroupId = '';
        refreshGroups();
        syncGenerateButton();
        setStatus('');
        scheduleDraftSave();
    }

    function openLightbox(group, index){
        lightboxItems = group.cards.map((card, itemIndex) => card.url ? ({url:card.url, title:`${group.title} · ${String(itemIndex + 1).padStart(2,'0')}`}) : null).filter(Boolean);
        const clickedUrl = group.cards[index]?.url;
        lightboxIndex = Math.max(0, lightboxItems.findIndex(item => item.url === clickedUrl));
        renderLightbox();
        $('detailLightbox').hidden = false;
        document.body.classList.add('detail-lightbox-open');
    }

    function renderLightbox(){
        const item = lightboxItems[lightboxIndex];
        if(!item) return;
        $('lightboxImage').src = item.url;
        $('lightboxTitle').textContent = item.title;
        $('lightboxCounter').textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
        $('lightboxDownload').href = item.url;
        $('lightboxDownload').download = `${item.title.replace(/\s*[·/]\s*/g, '-')}.png`;
        $('lightboxPrev').disabled = lightboxItems.length <= 1;
        $('lightboxNext').disabled = lightboxItems.length <= 1;
    }

    function closeLightbox(){
        $('detailLightbox').hidden = true;
        document.body.classList.remove('detail-lightbox-open');
    }

    function stepLightbox(delta){
        if(!lightboxItems.length) return;
        lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
        renderLightbox();
    }

    function serializableGroup(group){
        return {
            id:group.id,
            serial:group.serial,
            title:group.title,
            status:['success','partial','error','canceled'].includes(group.status) ? group.status : 'canceled',
            error:['analyzing','running'].includes(group.status) ? '上次任务在页面关闭前尚未完成。' : group.error,
            analysisSource:group.analysisSource,
            analysisNotice:group.analysisNotice,
            startedAt:group.startedAt,
            config:group.config,
            sources:group.sources,
            providerName:group.providerName,
            cards:group.cards.map(card => ({
                id:card.id,
                title:card.title,
                prompt:card.prompt,
                status:card.status === 'success' ? 'success' : card.status === 'error' ? 'error' : 'canceled',
                url:card.status === 'success' ? card.url : '',
                error:['pending','running'].includes(card.status) ? '上次任务在页面关闭前尚未完成。' : card.error,
                startedAt:card.startedAt,
                completedAt:card.completedAt,
                selected:Boolean(card.selected && card.status === 'success' && card.url),
                sources:Array.isArray(card.sources) ? card.sources : null,
                promptOptimization:card.promptOptimization ? {
                    ...card.promptOptimization,
                    status:card.promptOptimization.status === 'running' ? 'error' : card.promptOptimization.status,
                    error:card.promptOptimization.status === 'running' ? '上次提示词优化在页面关闭前尚未完成。' : card.promptOptimization.error,
                    taskId:''
                } : undefined
            }))
        };
    }

    function formSnapshot(){
        return {
            ...formValues(),
            products:state.products,
            references:state.references,
            groups:state.groups.map(serializableGroup),
            groupSerial:state.groupSerial,
            viewCount:state.viewCount,
            sortAscending:state.sortAscending,
            activeGroupId:state.activeGroupId,
            controlsCollapsed:state.controlsCollapsed
        };
    }

    function saveDraft(){
        draftSaveTimer = null;
        try { localStorage.setItem(DETAIL_STORAGE_KEY, JSON.stringify(formSnapshot())); } catch(error) {}
    }

    function scheduleDraftSave(){
        if(draftSaveTimer) clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(saveDraft, 180);
    }

    function normalizeRestoredGroup(item, index){
        if(item?.config && Array.isArray(item.cards)){
            const group = {
                ...item,
                id:item.id || uid(),
                serial:Number(item.serial) || index + 1,
                title:item.title || `分组 #${Number(item.serial) || index + 1}`,
                sources:Array.isArray(item.sources) ? item.sources.filter(source => source?.url).slice(0, MAX_SOURCE_IMAGES) : [],
                cards:item.cards.map((card, cardIndex) => ({
                    id:card.id || `${item.id || 'restored'}-card-${cardIndex + 1}`,
                    title:card.title || `主图 ${cardIndex + 1}`,
                    prompt:card.prompt || '',
                    status:card.url ? 'success' : card.status === 'error' ? 'error' : 'canceled',
                    url:card.url || '',
                    error:card.error || '',
                    startedAt:card.startedAt || Date.now(),
                    completedAt:Number(card.completedAt) || (card.url ? Number(card.startedAt) || Date.now() : 0),
                    selected:Boolean(card.selected && card.url),
                    sources:Array.isArray(card.sources) ? card.sources.filter(source => source?.url).slice(0, MAX_SOURCE_IMAGES) : null,
                    promptOptimization:card.promptOptimization && typeof card.promptOptimization === 'object' ? {
                        status:['idle','ready','error'].includes(card.promptOptimization.status) ? card.promptOptimization.status : 'error',
                        sourcePrompt:card.promptOptimization.sourcePrompt || card.prompt || '',
                        instruction:card.promptOptimization.instruction || '',
                        result:card.promptOptimization.result || '',
                        message:card.promptOptimization.message || '',
                        error:card.promptOptimization.error || '',
                        taskId:'',
                        startedAt:Number(card.promptOptimization.startedAt) || 0
                    } : {status:'idle', sourcePrompt:card.prompt || '', instruction:'', result:'', message:'', error:'', taskId:'', startedAt:0}
                })),
                controller:new AbortController()
            };
            if(['analyzing','running'].includes(group.status)) group.status = 'canceled';
            return group;
        }
        const images = Array.isArray(item?.images) ? item.images.filter(Boolean) : [];
        const serial = index + 1;
        const config = {...formValues(), count:Math.max(1, images.length || 1)};
        const prompts = localPromptCards(config);
        return {
            id:uid(), serial, title:`分组 #${serial}`,
            status:images.length ? 'success' : 'error',
            error:item?.error || '', analysisSource:'旧版草稿', analysisNotice:'', startedAt:Date.now(),
            config, sources:selectedRefs(), providerName:providerName(config.provider), controller:new AbortController(),
            cards:prompts.map((prompt, cardIndex) => ({id:`legacy-${serial}-${cardIndex}`, title:prompt.title, prompt:prompt.prompt, status:images[cardIndex] ? 'success' : 'error', url:images[cardIndex] || '', error:images[cardIndex] ? '' : item?.error || '旧任务没有返回图片', startedAt:Date.now(), completedAt:Date.now(), selected:false, sources:null}))
        };
    }

    function restoreDraft(){
        let draft = null;
        try { draft = JSON.parse(localStorage.getItem(DETAIL_STORAGE_KEY) || (LEGACY_STORAGE_KEY ? localStorage.getItem(LEGACY_STORAGE_KEY) : '') || 'null'); }
        catch(error){ draft = null; }
        if(!draft || typeof draft !== 'object'){
            renderProducts();
            renderReferences();
            refreshGroups();
            return;
        }
        $('productName').value = draft.productName || '';
        $('brandName').value = draft.brandName || '';
        $('sellingPoints').value = draft.sellingPoints || '';
        $('userPrompt').value = draft.userPrompt || '';
        $('outputLanguage').value = draft.outputLanguage || '中文';
        if(['wide','portrait','portrait43','square'].includes(draft.ratio)) $('ratioSelect').value = draft.ratio;
        syncSizeOptions(draft.size || '');
        if(['auto','low','medium','high'].includes(draft.quality)) $('qualitySelect').value = draft.quality;
        if(['1','2','4','6','8'].includes(String(draft.count))) $('countSelect').value = String(draft.count);
        if(['continuous','creative'].includes(draft.mainType || draft.mode)) setGenerationMode(draft.mainType || draft.mode, false);
        if(['required','blank','poster','none'].includes(draft.copySetting)) $('copySettingSelect').value = draft.copySetting === 'none' ? 'blank' : draft.copySetting;
        if(['classic','medium','rich'].includes(draft.richness || draft.style)) $('styleSelect').value = draft.richness || draft.style;
        if(['auto','modern','serif','hand'].includes(draft.fontStyle)) $('fontStyleSelect').value = draft.fontStyle;
        if(['use','none'].includes(draft.modelSettings)) $('modelSettings').value = draft.modelSettings;
        if(['natural','special'].includes(draft.modelPose)) $('modelPose').value = draft.modelPose;
        if(['1','2','3','4','5','6'].includes(String(draft.modelUsage))) $('modelUsage').value = String(draft.modelUsage);
        $('fontProtection').checked = draft.fontProtection !== false;
        if(draft.provider) state.provider = draft.provider;
        if(draft.model) state.model = draft.model;
        if(draft.chatProvider) state.chatProvider = draft.chatProvider;
        if(draft.chatModel) state.chatModel = draft.chatModel;
        state.products = Array.isArray(draft.products) ? draft.products.filter(item => item?.url).slice(0, MAX_SOURCE_IMAGES) : (draft.product?.url ? [draft.product] : []);
        state.references = Array.isArray(draft.references) ? draft.references.slice(0,6).map(item => item?.url ? item : null) : [];
        while(state.references.length < 6) state.references.push(null);
        while(sourceCount() > MAX_SOURCE_IMAGES){
            const lastRef = state.references.map((item,index) => item ? index : -1).filter(index => index >= 0).pop();
            if(lastRef != null) state.references[lastRef] = null;
            else state.products.pop();
        }
        state.viewCount = [4,5,6,8].includes(Number(draft.viewCount)) ? Number(draft.viewCount) : 8;
        state.sortAscending = draft.sortAscending !== false;
        state.activeGroupId = draft.activeGroupId || '';
        state.controlsCollapsed = Boolean(draft.controlsCollapsed);
        $('displayCount').value = String(state.viewCount);
        $('sortToggle').checked = state.sortAscending;
        state.groups = Array.isArray(draft.groups) ? draft.groups.map(normalizeRestoredGroup).filter(Boolean) : [];
        state.groupSerial = Math.max(Number(draft.groupSerial) || 0, ...state.groups.map(group => Number(group.serial) || 0), 0);
        renderProducts();
        renderReferences();
        refreshGroups();
        syncControlsPanel();
    }

    function savePreset(){
        try {
            const preset = formSnapshot();
            preset.groups = [];
            preset.groupSerial = 0;
            localStorage.setItem(DETAIL_PRESET_KEY, JSON.stringify(preset));
            setStatus('预设已保存。');
        } catch(error){ setStatus('预设保存失败。', true); }
    }

    function loadPreset(){
        let preset = null;
        try { preset = JSON.parse(localStorage.getItem(DETAIL_PRESET_KEY) || localStorage.getItem(LEGACY_PRESET_KEY) || 'null'); }
        catch(error){ preset = null; }
        if(!preset){ setStatus('还没有保存的预设。', true); return; }
        try {
            localStorage.setItem(DETAIL_STORAGE_KEY, JSON.stringify({...preset, groups:[], groupSerial:0}));
            window.location.reload();
        } catch(error){ setStatus('预设加载失败。', true); }
    }

    function openPromptAssistant(){
        $('userPrompt').focus();
        if(!$('userPrompt').value.trim()) $('userPrompt').value = '请写明必须出现或禁止出现的场景、构图、文案、模特和商品细节；这里的要求拥有最高优先级。';
        scheduleDraftSave();
    }

    function startLoadingTicker(){
        if(loadingTicker) clearInterval(loadingTicker);
        loadingTicker = setInterval(() => {
            document.querySelectorAll('[data-wait-start]').forEach(node => {
                const seconds = Math.max(0, Math.floor((Date.now() - Number(node.dataset.waitStart || Date.now())) / 1000));
                node.textContent = `已等待 ${seconds}s`;
            });
        }, 1000);
    }

    function bind(){
        $('productDrop').addEventListener('click', event => {
            const remove = event.target.closest('[data-remove-product]');
            if(remove){
                event.stopPropagation();
                state.products.splice(Number(remove.dataset.removeProduct), 1);
                renderProducts();
                renderReferences();
                scheduleDraftSave();
                return;
            }
            if(!event.target.closest('button')) $('productInput').click();
        });
        $('productInput').onchange = event => { void chooseProducts(event.target.files); event.target.value = ''; };
        $('clearProductBtn').onclick = event => {
            event.stopPropagation();
            state.products = [];
            renderProducts();
            renderReferences();
            scheduleDraftSave();
        };
        ['dragover','dragenter'].forEach(type => $('productDrop').addEventListener(type, event => { event.preventDefault(); $('productDrop').classList.add('drag-over'); }));
        ['dragleave','drop'].forEach(type => $('productDrop').addEventListener(type, event => { event.preventDefault(); $('productDrop').classList.remove('drag-over'); }));
        $('productDrop').addEventListener('drop', event => void chooseProducts(event.dataTransfer.files));
        $('referenceGrid').addEventListener('click', event => {
            const slot = event.target.closest('.reference-slot');
            if(!slot) return;
            const index = Number(slot.dataset.refIndex || 0);
            if(event.target.closest('.ref-remove')){
                state.references[index] = null;
                renderProducts();
                renderReferences();
                scheduleDraftSave();
                return;
            }
            if(slot.classList.contains('disabled')) return;
            $('referenceInput').dataset.index = String(index);
            $('referenceInput').click();
        });
        $('referenceInput').onchange = event => {
            const index = Number(event.target.dataset.index || 0);
            void chooseReference(index, event.target.files?.[0]);
            event.target.value = '';
        };
        $('cardReferenceInput').onchange = event => {
            void chooseCardReference(event.target.files?.[0]);
            event.target.value = '';
        };
        $('continueAddBtn').onclick = () => $('productInput').click();
        $('productLibraryBtn').onclick = () => openAssetPicker('products');
        $('referenceLibraryBtn').onclick = () => openAssetPicker('reference');
        $('providerSelect').onchange = event => {
            state.provider = event.target.value;
            state.model = '';
            renderModels();
            $('providerBadge').textContent = providerName(state.provider);
            scheduleDraftSave();
        };
        $('modelSelect').onchange = event => { state.model = event.target.value; scheduleDraftSave(); };
        $('chatProviderSelect').onchange = event => {
            state.chatProvider = event.target.value;
            state.chatModel = '';
            renderChatModels();
            scheduleDraftSave();
        };
        $('chatModelSelect').onchange = event => { state.chatModel = event.target.value; scheduleDraftSave(); };
        $('mainTypeSelect').onchange = event => setGenerationMode(event.target.value);
        $('ratioSelect').onchange = () => { syncSizeOptions(''); scheduleDraftSave(); };
        ['productName','brandName','sellingPoints','userPrompt','outputLanguage','sizeSelect','qualitySelect','countSelect','styleSelect','copySettingSelect','fontStyleSelect','modelSettings','modelPose','modelUsage','fontProtection'].forEach(id => $(id)?.addEventListener('input', scheduleDraftSave));
        $('displayCount').onchange = event => { state.viewCount = Number(event.target.value) || 8; refreshGroups(); scheduleDraftSave(); };
        $('sortToggle').onchange = event => { state.sortAscending = event.target.checked; refreshGroups(); scheduleDraftSave(); };
        $('detailPanelToggle').onclick = () => {
            state.controlsCollapsed = !state.controlsCollapsed;
            syncControlsPanel();
            scheduleDraftSave();
        };
        $('savePresetBtn').onclick = savePreset;
        $('loadPresetBtn').onclick = loadPreset;
        $('generatePromptBtn').onclick = startGeneration;
        $('promptAssistantBtn').onclick = openPromptAssistant;
        $('downloadAllBtn').onclick = downloadAll;
        $('clearResultsBtn').onclick = clearResults;
        $('openApiSettingsBtn').onclick = openApiSettings;
        $('groupTabs').addEventListener('click', event => {
            const tab = event.target.closest('[data-group-tab]');
            if(!tab) return;
            state.activeGroupId = tab.dataset.groupTab;
            renderGroupTabs();
            document.getElementById(`detail-${state.activeGroupId}`)?.scrollIntoView({behavior:'smooth', block:'start'});
        });
        $('detailGroups').addEventListener('click', event => {
            const groupAction = event.target.closest('[data-group-action]');
            if(groupAction){
                const group = findGroup(groupAction.dataset.groupId);
                const action = groupAction.dataset.groupAction;
                if(action === 'cancel') cancelGroup(group);
                if(action === 'retry') void retryGroup(group);
                if(action === 'delete'){
                    abortGroupTasks(group);
                    state.groups = state.groups.filter(item => item !== group);
                    refreshGroups();
                    syncGenerateButton();
                    scheduleDraftSave();
                }
                if(action === 'download') void downloadGroup(group);
                if(action === 'download-selected') void downloadSelectedGroup(group);
                if(action === 'collage') void openCollage(group);
                if(action === 'switch-model') switchGroupModel(group);
                if(action === 'rename') beginRenameGroup(group);
                if(action === 'api') openApiSettings();
                return;
            }
            const cardAction = event.target.closest('[data-card-action]');
            if(cardAction){
                const group = findGroup(cardAction.dataset.groupId);
                const index = Number(cardAction.dataset.cardIndex || 0);
                if(cardAction.dataset.cardAction === 'prompt') openPromptEditor(group, index);
                if(cardAction.dataset.cardAction === 'retry') void rerunCard(group, index);
                if(cardAction.dataset.cardAction === 'zoom') openLightbox(group, index);
                if(cardAction.dataset.cardAction === 'add-reference'){
                    state.cardReferenceTarget = {groupId:group?.id || '', cardIndex:index};
                    $('cardReferenceInput').click();
                }
                return;
            }
            const card = event.target.closest('[data-preview-card="true"]');
            if(card && !event.target.closest('button, a, input, label, .output-tools')) openLightbox(findGroup(card.dataset.groupId), Number(card.dataset.cardIndex || 0));
        });
        $('detailGroups').addEventListener('dragstart', event => {
            const handle = event.target.closest('[data-card-drag]');
            if(!handle) return;
            const group = findGroup(handle.dataset.groupId);
            const index = Number(handle.dataset.cardIndex || 0);
            if(!group?.cards?.[index]) return;
            draggedCard = {groupId:group.id, index};
            handle.closest('.output-card')?.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', `${group.id}:${index}`);
        });
        $('detailGroups').addEventListener('dragover', event => {
            const target = event.target.closest('.output-card');
            if(!draggedCard || !target || target.dataset.groupId !== draggedCard.groupId) return;
            const targetIndex = Number(target.dataset.cardIndex || 0);
            if(targetIndex === draggedCard.index) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            document.querySelectorAll('.output-card.drag-before, .output-card.drag-after').forEach(card => card.classList.remove('drag-before', 'drag-after'));
            const rect = target.getBoundingClientRect();
            const after = event.clientX >= rect.left + rect.width / 2;
            target.classList.add(after ? 'drag-after' : 'drag-before');
            target.dataset.dropAfter = after ? 'true' : 'false';
        });
        $('detailGroups').addEventListener('drop', event => {
            const target = event.target.closest('.output-card');
            if(!draggedCard || !target || target.dataset.groupId !== draggedCard.groupId) return;
            event.preventDefault();
            const group = findGroup(draggedCard.groupId);
            const fromIndex = draggedCard.index;
            const targetIndex = Number(target.dataset.cardIndex || 0);
            if(!group?.cards?.[fromIndex] || !group.cards[targetIndex]) return;
            let insertIndex = targetIndex + (target.dataset.dropAfter === 'true' ? 1 : 0);
            const [moved] = group.cards.splice(fromIndex, 1);
            if(fromIndex < insertIndex) insertIndex -= 1;
            insertIndex = Math.max(0, Math.min(group.cards.length, insertIndex));
            group.cards.splice(insertIndex, 0, moved);
            draggedCard = null;
            refreshGroups();
            setStatus(`${group.title || `分组 #${group.serial}`} 已更新图片顺序。`);
            scheduleDraftSave();
        });
        $('detailGroups').addEventListener('dragend', () => {
            draggedCard = null;
            document.querySelectorAll('.output-card.dragging, .output-card.drag-before, .output-card.drag-after').forEach(card => card.classList.remove('dragging', 'drag-before', 'drag-after'));
        });
        $('detailGroups').addEventListener('change', event => {
            const checkbox = event.target.closest('[data-card-select]');
            if(!checkbox) return;
            const group = findGroup(checkbox.dataset.groupId);
            const card = group?.cards?.[Number(checkbox.dataset.cardIndex || 0)];
            if(!card) return;
            card.selected = Boolean(checkbox.checked && card.url);
            refreshGroups();
            scheduleDraftSave();
        });
        $('detailGroups').addEventListener('focusout', event => {
            const input = event.target.closest('[data-group-rename-input]');
            if(!input || state.renamingGroupId !== input.dataset.groupId) return;
            commitRenameGroup(findGroup(input.dataset.groupId), input.value);
        });
        $('detailGroups').addEventListener('keydown', event => {
            const input = event.target.closest('[data-group-rename-input]');
            if(!input) return;
            if(event.key === 'Enter'){
                event.preventDefault();
                commitRenameGroup(findGroup(input.dataset.groupId), input.value);
            }
            if(event.key === 'Escape'){
                event.preventDefault();
                cancelRenameGroup();
            }
        });
        $('lightboxClose').onclick = closeLightbox;
        $('lightboxPrev').onclick = () => stepLightbox(-1);
        $('lightboxNext').onclick = () => stepLightbox(1);
        $('detailLightbox').addEventListener('click', event => { if(event.target === $('detailLightbox')) closeLightbox(); });
        $('collageClose').onclick = closeCollage;
        $('collageDownload').onclick = downloadCollage;
        $('collageModal').addEventListener('click', event => { if(event.target === $('collageModal')) closeCollage(); });
        $('assetPickerClose').onclick = closeAssetPicker;
        $('assetPickerCancel').onclick = closeAssetPicker;
        $('assetPickerModal').addEventListener('click', event => { if(event.target === $('assetPickerModal')) closeAssetPicker(); });
        $('assetPickerSources').addEventListener('click', event => {
            const source = event.target.closest('[data-picker-source]')?.dataset.pickerSource;
            if(!source || source === state.assetPicker.source) return;
            state.assetPicker.source = source;
            state.assetPicker.categoryId = '';
            state.assetPicker.selectedIds.clear();
            renderAssetPicker();
        });
        $('assetPickerLibrary').onchange = event => {
            state.assetPicker.libraryId = event.target.value;
            state.assetPicker.categoryId = '';
            state.assetPicker.selectedIds.clear();
            renderAssetPicker();
        };
        $('assetPickerCategory').onchange = event => {
            state.assetPicker.categoryId = event.target.value;
            state.assetPicker.selectedIds.clear();
            renderAssetPicker();
        };
        $('assetPickerSearch').addEventListener('input', event => {
            state.assetPicker.query = event.target.value || '';
            renderAssetPicker();
        });
        $('assetPickerGrid').addEventListener('click', event => {
            const itemButton = event.target.closest('[data-picker-item]');
            if(!itemButton || itemButton.disabled) return;
            const picker = state.assetPicker;
            const item = [...picker.libraryItems, ...picker.localItems].find(entry => entry.pickerId === itemButton.dataset.pickerItem);
            if(!item) return;
            if(picker.mode === 'reference') picker.selectedIds = new Set([item.pickerId]);
            else if(picker.selectedIds.has(item.pickerId)) picker.selectedIds.delete(item.pickerId);
            else picker.selectedIds.add(item.pickerId);
            renderAssetPicker();
        });
        $('assetPickerConfirm').onclick = confirmAssetPicker;
        $('promptEditClose').onclick = closePromptEditor;
        $('promptEditCancel').onclick = closePromptEditor;
        $('promptEditModal').addEventListener('click', event => { if(event.target === $('promptEditModal')) closePromptEditor(); });
        $('promptRestoreBtn').onclick = () => {
            const {card} = editingContext();
            if(!card) return;
            $('promptEditInput').value = card.prompt || '';
            updatePromptCounts();
        };
        $('promptEditInput').addEventListener('input', updatePromptCounts);
        $('promptEditInstruction').addEventListener('input', () => {
            const {card} = editingContext();
            if(card){
                promptTask(card).instruction = $('promptEditInstruction').value;
                scheduleDraftSave();
            }
        });
        $('promptOptimizeBtn').onclick = () => void optimizePrompt();
        $('promptApplyBtn').onclick = () => void applyOptimizedPrompt();
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && !$('promptEditModal').hidden){ closePromptEditor(); return; }
            if(event.key === 'Escape' && !$('assetPickerModal').hidden){ closeAssetPicker(); return; }
            if(event.key === 'Escape' && !$('collageModal').hidden){ closeCollage(); return; }
            if(event.key === 'Escape' && !$('detailLightbox').hidden){ closeLightbox(); return; }
            if(!$('detailLightbox').hidden && event.key === 'ArrowLeft') stepLightbox(-1);
            if(!$('detailLightbox').hidden && event.key === 'ArrowRight') stepLightbox(1);
        });
    }

    window.addEventListener('message', event => {
        if(event.data?.type === 'studio-theme' && window.StudioTheme) StudioTheme.set(event.data.theme);
        if(event.data?.type === 'providers-changed') void loadProviders();
        if(event.data?.type === 'studio-lang' && window.StudioI18n) StudioI18n.set(event.data.lang);
        if(event.data?.type === 'asset_library_updated' && !$('assetPickerModal')?.hidden) void loadAssetPickerData();
    });
    window.addEventListener('studio-lang-change', applyLanguage);
    window.addEventListener('beforeunload', saveDraft);
    window.addEventListener('DOMContentLoaded', async () => {
        window.StudioTheme?.apply?.(window.StudioTheme?.get?.());
        bind();
        syncSizeOptions('');
        window.StudioI18n?.apply?.();
        applyLanguage();
        restoreDraft();
        syncControlsPanel();
        await loadProviders();
        $('taskActions').hidden = true;
        syncGenerateButton();
        startLoadingTicker();
        window.lucide?.createIcons();
    });
})();
