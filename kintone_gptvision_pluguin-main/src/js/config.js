(function(PLUGIN_ID) {
  const formEl = document.querySelector('.js-submit-settings');
  const cancelButtonEl = document.querySelector('.js-cancel-button');
  const apikeyEl = document.querySelector('.js-apikey');
  const modelEl = document.querySelector('.js-model');
  const roleEl = document.querySelector('.js-role');
  const reasoningEl = document.querySelector('.js-reasoning');
  const fileFieldEl = document.querySelector('.js-file-field');
  const replyFieldEl = document.querySelector('.js-reply-field');
  const spaceIdEl = document.querySelector('.js-space-id');
  const defaultModel = 'gpt-5.2';
  const defaultReasoning = 'none';
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
  const baseReasoningOptions = ['none', 'low', 'medium', 'high', 'xhigh'];
  const reasoningLabels = {
    none: 'none（最小）',
    xhigh: 'xhigh（最大）'
  };
  const normalizeModel = (model) => {
    const normalized = legacyModelMap[model] || model || defaultModel;
    if (!supportedModels.has(normalized)) return defaultModel;
    return normalized;
  };
  const getAllowedReasoning = () => baseReasoningOptions;
  const getDefaultReasoning = () => defaultReasoning;
  const normalizeReasoningEffort = (model, effort) => {
    const allowed = getAllowedReasoning(model);
    const fallback = getDefaultReasoning(model);
    const normalized = effort === 'minimal' ? 'none' : (effort || fallback);
    if (allowed.includes(normalized)) return normalized;
    if (allowed.includes(fallback)) return fallback;
    return allowed[0];
  };
  const updateReasoningOptions = (model, effort) => {
    const allowed = getAllowedReasoning(model);
    reasoningEl.innerHTML = '';
    allowed.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = reasoningLabels[value] || value;
      reasoningEl.appendChild(option);
    });
    reasoningEl.value = normalizeReasoningEffort(model, effort);
    reasoningEl.disabled = allowed.length === 1;
  };

  if (
    !formEl ||
    !cancelButtonEl ||
    !apikeyEl ||
    !modelEl ||
    !roleEl ||
    !reasoningEl ||
    !fileFieldEl ||
    !replyFieldEl ||
    !spaceIdEl
  ) {
    throw new Error('必須の要素が見つかりません。HTMLのクラス指定を確認してください。');
  }

  // 既存設定を反映
  const config = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  const initialModel = normalizeModel(config.model);
  apikeyEl.value = config.apikey || '';
  modelEl.value = initialModel;
  if (!modelEl.value) modelEl.value = defaultModel;
  roleEl.value = config.role || '';
  updateReasoningOptions(modelEl.value, config.reasoningEffort);
  fileFieldEl.value = config.fileField || '';
  replyFieldEl.value = config.replyField || '';
  spaceIdEl.value = config.spaceId || '';

  modelEl.addEventListener('change', () => {
    const normalized = normalizeModel(modelEl.value);
    if (normalized !== modelEl.value) {
      modelEl.value = normalized;
    }
    updateReasoningOptions(modelEl.value, reasoningEl.value);
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();

    const selectedModel = normalizeModel((modelEl.value || defaultModel).trim());
    const selectedReasoning = normalizeReasoningEffort(selectedModel, (reasoningEl.value || defaultReasoning).trim());
    const newConfig = {
      apikey: apikeyEl.value.trim(),
      model: selectedModel,
      reasoningEffort: selectedReasoning,
      role: roleEl.value.trim(),
      fileField: fileFieldEl.value.trim(),
      replyField: replyFieldEl.value.trim(),
      spaceId: spaceIdEl.value.trim()
    };

    const requiredFields = [
      { value: newConfig.apikey, label: 'APIキー' },
      { value: newConfig.model, label: 'モデル' },
      { value: newConfig.fileField, label: '添付ファイルフィールドコード' },
      { value: newConfig.replyField, label: '出力フィールドコード' },
      { value: newConfig.spaceId, label: 'スペースID' }
    ];

    const missing = requiredFields.find((field) => !field.value);
    if (missing) {
      alert(`${missing.label}を入力してください。`);
      return;
    }

    kintone.plugin.app.setConfig(newConfig, () => {
      alert('設定が保存されました。アプリを更新してください。');

      const url = 'https://api.openai.com/v1/responses';
      const method = 'POST';
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + newConfig.apikey
      };
      const data = {};
      kintone.plugin.app.setProxyConfig(
        url,
        method,
        headers,
        data,
        () => {
          console.log('プロキシ設定も保存されました');
          window.location.href = '../../flow?app=' + kintone.app.getId();
        },
        (error) => {
          console.error('プロキシ設定の保存中にエラーが発生しました:', error);
          alert('プロキシ設定の保存に失敗しました。もう一度お試しください。');
        }
      );
    }, (error) => {
      console.error('設定の保存中にエラーが発生しました:', error);
      alert('設定の保存に失敗しました。もう一度お試しください。');
    });
  });

  cancelButtonEl.addEventListener('click', () => {
    window.location.href = '../../' + kintone.app.getId() + '/plugin/';
  });
})(kintone.$PLUGIN_ID);
