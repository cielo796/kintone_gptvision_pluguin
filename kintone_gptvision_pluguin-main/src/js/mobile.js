(function(PLUGIN_ID) {
  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  const pluginId = PLUGIN_ID;

  const urlResponses = 'https://api.openai.com/v1/responses';

  const defaultModel = 'gpt-5.2';
  const defaultReasoning = 'none';
  const baseReasoningOptions = ['none', 'low', 'medium', 'high', 'xhigh'];
  const legacyModelMap = {
    'gpt-5.2-pro': 'gpt-5.2',
    'gpt-5-pro': 'gpt-5.2',
    'gpt-5.2-chat': 'gpt-5.2',
    'gpt-5.2-chat-latest': 'gpt-5.2',
    'gpt-5.1': 'gpt-5.2',
    'gpt-5.1-chat': 'gpt-5.2',
    'gpt-5.1-chat-latest': 'gpt-5.2',
    'gpt-5-mini': 'gpt-5.2',
    'gpt-5-nano': 'gpt-5.2'
  };
  const supportedModels = new Set(['gpt-5.2']);
  const normalizeModel = (model) => {
    const normalized = legacyModelMap[model] || model || defaultModel;
    if (!supportedModels.has(normalized)) return defaultModel;
    return normalized;
  };

  const normalizeReasoningEffort = (model, effort) => {
    const fallback = defaultReasoning;
    const normalized = effort === 'minimal' ? 'none' : (effort || fallback);
    const allowed = baseReasoningOptions;
    if (allowed.includes(normalized)) return normalized;
    if (allowed.includes(fallback)) return fallback;
    return allowed[0];
  };

  const defaultPrompt = [
    '添付画像を解析し、内容の要約と読み取れる文字を日本語で出力してください。',
    '複数枚ある場合は、ファイル名を見出しにして順番に出力してください。',
    '回答はプレーンテキストのみで返してください。'
  ].join('\n');
  const rawModel = config.model || defaultModel;
  const safeModel = normalizeModel(rawModel);
  if (rawModel && safeModel !== rawModel) {
    console.warn('設定モデルが非対応のため gpt-5.2 に移行しました。', rawModel);
  }
  const safeReasoning = normalizeReasoningEffort(safeModel, config.reasoningEffort);
  const safeSystem = (config.role || '').trim() || defaultPrompt;

  const extractAssistantText = (resp) => {
    if (typeof resp.output_text === 'string' && resp.output_text.trim()) {
      return resp.output_text.trim();
    }

    const out = Array.isArray(resp.output) ? resp.output : [];
    const message =
      [...out].reverse().find((x) => x?.type === 'message' && x?.role === 'assistant') ||
      out.find((x) => x?.type === 'message');

    const parts = Array.isArray(message?.content) ? message.content : [];
    return parts
      .filter((p) => p && (p.type === 'output_text' || p.type === 'text'))
      .map((p) => p.text)
      .join('\n')
      .trim();
  };

  const proxyRequest = (url, method, headers, data) =>
    new Promise((resolve, reject) => {
      const success = (body, status, responseHeaders) => resolve({ body, status, headers: responseHeaders });
      const failure = (error) => reject(error);

      if (kintone.app && typeof kintone.app.proxy === 'function') {
        kintone.app.proxy(url, method, headers, data, success, failure);
        return;
      }

      if (typeof kintone.proxy === 'function') {
        kintone.proxy(url, method, headers, data, success, failure);
        return;
      }

      kintone.plugin.app.proxy(pluginId, url, method, headers, data, success, failure);
    });

  const requestOpenai = async ({ url, method, headers, data, timeoutMs }) => {
    try {
      const controller = new AbortController();
      const effectiveTimeoutMs = timeoutMs ?? 180000;
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      try {
        const options = { method, headers, signal: controller.signal };
        if (data !== undefined && method !== 'GET' && method !== 'HEAD') {
          options.body = data;
        }
        const res = await fetch(url, options);
        const body = await res.text();
        return { body, status: res.status };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (fetchError) {
      try {
        const proxyData = data ?? '';
        return await proxyRequest(url, method, headers, proxyData);
      } catch (proxyError) {
        const fetchDetail = fetchError?.message || fetchError;
        const proxyDetail = proxyError?.message || proxyError;
        throw new Error(`Fetch失敗: ${fetchDetail}; Proxy失敗: ${proxyDetail}`);
      }
    }
  };

  const createResponse = async (payload) =>
    requestOpenai({
      url: urlResponses,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apikey}`,
        'Content-Type': 'application/json'
      },
      data: JSON.stringify(payload),
      timeoutMs: 180000
    });

  const runResponse = async (payload) => {
    const { body, status } = await createResponse(payload);
    if (status < 200 || status >= 300) {
      throw new Error(`API呼び出しに失敗しました (HTTP ${status}): ${body}`);
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error('APIレスポンスのJSON解析に失敗しました。');
    }
  };

  const readBlobAsBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.split(',')[1] || '';
      if (!base64) {
        reject(new Error('画像の読み込みに失敗しました。'));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => {
      reject(reader.error || new Error('画像の読み込みに失敗しました。'));
    };
    reader.readAsDataURL(blob);
  });

  const fetchFileAsBase64 = async (fileKey) => {
    const fileUrl = kintone.api.url('/k/v1/file', true) + '?fileKey=' + encodeURIComponent(fileKey);
    const blobRes = await fetch(fileUrl, {
      method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!blobRes.ok) {
      throw new Error(`ファイルの取得に失敗しました (HTTP ${blobRes.status})`);
    }
    const fileBlob = await blobRes.blob();
    return readBlobAsBase64(fileBlob);
  };

  const buildImageContents = async (files) => {
    const imageFiles = files.filter((file) => file?.contentType?.startsWith('image/'));
    const contents = await Promise.all(imageFiles.map(async (file) => {
      const base64 = await fetchFileAsBase64(file.fileKey);
      return {
        name: file.name || 'image',
        contentType: file.contentType || 'image/png',
        base64
      };
    }));
    return contents.filter((item) => item.base64);
  };

  const buildUserContent = (imageContents) => {
    const userContent = [
      { type: 'input_text', text: '添付画像を解析してください。' }
    ];
    imageContents.forEach((image, index) => {
      userContent.push({
        type: 'input_text',
        text: `画像${index + 1}: ${image.name}`
      });
      userContent.push({
        type: 'input_image',
        image_url: `data:${image.contentType};base64,${image.base64}`
      });
    });
    return userContent;
  };

  const buildEditUrl = () => {
    const appId = kintone.mobile?.app?.getId ? kintone.mobile.app.getId() : kintone.app.getId();
    const recordId = kintone.mobile?.app?.record?.getId
      ? kintone.mobile.app.record.getId()
      : kintone.app.record.getId();
    if (!appId || !recordId) {
      return null;
    }
    const isMobile = location.pathname.includes('/k/m/');
    const basePath = isMobile ? `/k/m/${appId}/show` : `/k/${appId}/show`;
    if (isMobile) {
      return `${basePath}?record=${recordId}&mode=edit`;
    }
    return `${basePath}#record=${recordId}&mode=edit`;
  };

  kintone.events.on('mobile.app.record.detail.show', function(event) {
    const spaceElement = kintone.mobile.app.record.getSpaceElement(config.spaceId);
    if (!spaceElement) {
      console.warn('スペースフィールドが見つかりません。', config.spaceId);
      return event;
    }

    if (spaceElement.querySelector('#ai-image-button')) {
      return event;
    }

    const requiredSettings = ['apikey', 'fileField', 'replyField', 'spaceId'];
    const missing = requiredSettings.find((key) => !config[key]);
    if (missing) {
      const warn = document.createElement('div');
      warn.textContent = 'プラグイン設定が完了していません。設定画面で必要項目を入力してください。';
      warn.style.color = '#d23f31';
      spaceElement.appendChild(warn);
      return event;
    }

    const button = new Kuc.MobileButton({
      text: '画像を解析',
      type: 'submit',
      id: 'ai-image-button',
      className: 'js-openai-image-button',
      visible: true
    });

    const notification = new Kuc.MobileNotification({
      text: '処理中です。しばらくお待ちください。',
      duration: -1
    });

    spaceElement.appendChild(button);

    button.addEventListener('click', async () => {
      button.disabled = true;

      const record = kintone.mobile.app.record.get();
      const files = record.record[config.fileField]?.value || [];

      if (!files.length) {
        alert('添付ファイルがありません。画像を追加してください。');
        button.disabled = false;
        return;
      }

      notification.text = '画像を取得しています...';
      notification.open();

      try {
        const imageContents = await buildImageContents(files);
        if (!imageContents.length) {
          notification.text = '添付ファイルに画像がありません。';
          setTimeout(() => notification.close(), 2000);
          return;
        }

        const responsePayload = {
          model: safeModel,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: safeSystem }]
            },
            {
              role: 'user',
              content: buildUserContent(imageContents)
            }
          ],
          reasoning: { effort: safeReasoning },
          metadata: { source: 'kintone-image-plugin' }
        };

        notification.text = 'AIが回答を生成しています...';

        let responseJson;
        try {
          responseJson = await runResponse(responsePayload);
        } catch (requestError) {
          const detail = requestError?.message || requestError;
          throw new Error('OpenAI APIの呼び出しに失敗しました: ' + detail);
        }

        const aiText = extractAssistantText(responseJson);
        if (!aiText) {
          throw new Error('AIの回答テキストが取得できませんでした。');
        }

        sessionStorage.setItem('aiGeneratedText', aiText);
        notification.close();

        const editUrl = buildEditUrl();
        if (editUrl) {
          location.href = editUrl;
        } else {
          notification.text = '解析が完了しました。編集画面で貼り付けてください。';
          setTimeout(() => notification.close(), 2000);
        }
      } catch (error) {
        console.error('処理中にエラーが発生しました:', error);
        notification.text = `処理中にエラーが発生しました: ${error.message || error}`;
        setTimeout(() => notification.close(), 4000);
      } finally {
        button.disabled = false;
      }
    });

    return event;
  });

  kintone.events.on(['mobile.app.record.edit.show', 'mobile.app.record.create.show'], function(event) {
    const aiGeneratedText = sessionStorage.getItem('aiGeneratedText');
    if (aiGeneratedText && config.replyField && event.record[config.replyField]) {
      event.record[config.replyField].value = aiGeneratedText;
      sessionStorage.removeItem('aiGeneratedText');
    }
    return event;
  });
})(kintone.$PLUGIN_ID);
