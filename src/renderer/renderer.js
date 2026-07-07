const state = {
  authMode: "login",
  phone: "13800138000",
  password: "123456",
  activeSection: "chat",
  activeChatId: "chat-1",
  registerWechatStatus: "qr",
  profileWechatStatus: "bound"
};

const chats = [
  {
    id: "chat-1",
    title: "小红书探店文案",
    time: "今天 10:20",
    preview: "帮我写一篇咖啡店探店图文",
    messages: [
      { role: "user", text: "帮我写一篇咖啡店探店图文，语气轻松一点。" },
      {
        role: "assistant",
        text: "可以。标题建议用「周末偷到半日闲，这家街角咖啡店太会了」。正文突出环境、招牌饮品、适合拍照的位置和人均消费。"
      }
    ]
  },
  {
    id: "chat-2",
    title: "新品发布朋友圈",
    time: "昨天 16:45",
    preview: "生成三条新品预热文案",
    messages: [
      { role: "user", text: "为夏季新品生成三条朋友圈预热文案。" },
      { role: "assistant", text: "第一条主打期待感，第二条主打场景，第三条主打限时权益。每条都可以配一张细节图。" }
    ]
  },
  {
    id: "chat-3",
    title: "公众号标题优化",
    time: "6月28日",
    preview: "让标题更适合内容运营",
    messages: [
      { role: "user", text: "这篇文章标题太平了，帮我优化。" },
      { role: "assistant", text: "建议标题聚焦结果和对象，比如「新手运营也能复用的 5 个内容增长动作」。" }
    ]
  }
];

const contents = [
  {
    title: "周末咖啡店探店指南",
    tag: "小红书图文",
    date: "今天 10:35",
    image: "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=800&q=80",
    detailImage: "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1200&q=80",
    inlineImages: [
      "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1000&q=80",
      "https://images.unsplash.com/photo-1442512595331-e89e73853f31?auto=format&fit=crop&w=1000&q=80"
    ],
    summary: "适合城市生活方式账号发布，包含标题、封面建议、正文和话题标签。",
    paragraphs: [
      "周末偷到半日闲，这家街角咖啡店太会了。",
      "推门就是烘焙香，靠窗的位置很适合一个人放空。招牌拿铁入口顺滑，甜度刚好，不会盖住咖啡本身的香气。",
      "推荐下午三点后去，光线落在木质桌面上很出片。适合朋友小聚、独处办公，也适合给城市生活方式账号做一篇轻松的探店内容。"
    ]
  },
  {
    title: "夏季新品预热三连发",
    tag: "朋友圈",
    date: "昨天 17:02",
    image: "https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=800&q=80",
    detailImage: "https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=1200&q=80",
    inlineImages: [
      "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1000&q=80",
      "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1000&q=80"
    ],
    summary: "三条不同情绪的朋友圈文案，覆盖悬念、场景和权益。",
    paragraphs: [
      "夏季新品即将上线，先把一点点清爽感提前放出来。",
      "第一条主打期待感：这次新品，我们想把夏天穿在身上。第二条主打场景：通勤、旅行、周末见朋友，都能轻松切换。",
      "第三条主打行动：首发限时福利已准备好，想第一时间试穿的朋友可以私信预约。"
    ]
  },
  {
    title: "运营增长文章标题库",
    tag: "公众号",
    date: "6月28日",
    image: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80",
    detailImage: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=1200&q=80",
    inlineImages: [
      "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1000&q=80",
      "https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1000&q=80"
    ],
    summary: "面向内容运营人的标题备选方案，便于 A/B 测试。",
    paragraphs: [
      "这组标题适合内容运营、增长复盘和方法论文章。",
      "清单型：新手运营也能复用的 5 个内容增长动作。结果型：我们用 30 天，把社群活跃提升了 42%。",
      "避坑型：内容更新很勤但没转化，可能卡在这 3 个环节。案例型：一个低预算账号如何靠选题跑出稳定流量。"
    ]
  },
  {
    title: "社群活动招募海报文案",
    tag: "活动图文",
    date: "6月26日",
    image: "https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=800&q=80",
    detailImage: "https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1200&q=80",
    inlineImages: [
      "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1000&q=80",
      "https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1000&q=80"
    ],
    summary: "用于社群活动报名页和配图，包含主标题、副标题和报名引导。",
    paragraphs: [
      "主标题：一起拆解一次高转化社群活动。",
      "副标题：90 分钟线上共创，从选题、招募、转化到复盘，带你搭出一套可复用流程。",
      "适合内容运营、社群负责人和私域增长同学参与。席位有限，扫码填写报名信息，审核通过后将收到入群通知。"
    ]
  }
];

const elements = {
  authView: document.querySelector("#authView"),
  appView: document.querySelector("#appView"),
  authForm: document.querySelector("#authForm"),
  authHint: document.querySelector("#authHint"),
  authSubmit: document.querySelector("#authSubmit"),
  authFields: document.querySelector("#authFields"),
  authWechatSetup: document.querySelector("#authWechatSetup"),
  phoneInput: document.querySelector("#phoneInput"),
  passwordInput: document.querySelector("#passwordInput"),
  modeTabs: document.querySelectorAll("[data-auth-mode]"),
  navItems: document.querySelectorAll("[data-section]"),
  sectionTitle: document.querySelector("#sectionTitle"),
  headerPhone: document.querySelector("#headerPhone"),
  profilePhone: document.querySelector("#profilePhone"),
  logoutButton: document.querySelector("#logoutButton"),
  historyList: document.querySelector("#historyList"),
  messageList: document.querySelector("#messageList"),
  chatTitle: document.querySelector("#chatTitle"),
  chatMeta: document.querySelector("#chatMeta"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  newChatButton: document.querySelector("#newChatButton"),
  libraryListView: document.querySelector("#libraryListView"),
  contentGrid: document.querySelector("#contentGrid"),
  contentDetail: document.querySelector("#contentDetail"),
  profileWechatState: document.querySelector("#profileWechatState"),
  profileForm: document.querySelector("#profileForm"),
  oldPasswordInput: document.querySelector("#oldPasswordInput"),
  newPasswordInput: document.querySelector("#newPasswordInput"),
  profileHint: document.querySelector("#profileHint")
};

const sectionNames = {
  chat: "对话",
  library: "内容库",
  profile: "个人中心"
};

function setAuthMode(mode) {
  state.authMode = mode;
  elements.modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.authMode === mode);
  });
  elements.authSubmit.textContent = mode === "login" ? "登录" : "注册并登录";
  elements.authHint.textContent =
    mode === "login"
      ? "演示账号已预填，可直接登录。"
      : state.registerWechatStatus === "bound"
        ? "微信通道已绑定，请设置手机号和密码完成注册。"
        : "请先扫码绑定 AI 员工通道，再完成账号注册。";
  elements.authHint.className = "form-hint";
  renderAuthWechatSetup();
}

function renderQrCode() {
  return `
    <div class="qr-code" aria-label="绑定二维码">
      ${Array.from({ length: 49 }, (_, index) => `<span style="opacity:${[0, 1, 2, 6, 7, 8, 14, 18, 24, 30, 34, 40, 42, 43, 44, 48].includes(index) ? 1 : index % 3 === 0 ? 0.85 : 0.08}"></span>`).join("")}
    </div>
  `;
}

function renderAuthWechatSetup() {
  const isRegister = state.authMode === "register";
  const isWechatBound = state.registerWechatStatus === "bound";

  elements.authWechatSetup.classList.toggle("hidden", !isRegister || isWechatBound);
  elements.authFields.classList.toggle("hidden", isRegister && !isWechatBound);
  elements.authSubmit.classList.toggle("hidden", isRegister && !isWechatBound);

  if (!isRegister || isWechatBound) {
    elements.authWechatSetup.innerHTML = "";
    return;
  }

  elements.authWechatSetup.innerHTML = `
    <div class="auth-qr-card">
      ${renderQrCode()}
      <strong>请使用微信扫码绑定 AI 员工通道</strong>
      <span>绑定后即可通过微信调遣 OpenClaw AI 员工，并继续创建平台账号。</span>
      <button id="completeRegisterWechatButton" class="primary-action" type="button">模拟扫码完成</button>
    </div>
  `;

  document.querySelector("#completeRegisterWechatButton").addEventListener("click", () => {
    state.registerWechatStatus = "bound";
    state.profileWechatStatus = "bound";
    setAuthMode("register");
  });
}

function enterApp() {
  state.phone = elements.phoneInput.value.trim();
  if (state.authMode === "register") {
    state.profileWechatStatus = "bound";
  }
  elements.headerPhone.textContent = state.phone;
  elements.profilePhone.textContent = state.phone;
  elements.authView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  renderAll();
}

function switchSection(section) {
  state.activeSection = section;
  elements.sectionTitle.textContent = sectionNames[section];
  elements.navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.section === section);
  });
  document.querySelectorAll(".section-view").forEach((view) => view.classList.add("hidden"));
  document.querySelector(`#${section}Section`).classList.remove("hidden");
  if (section === "profile") {
    renderProfileWechat();
  }
}

function renderHistory() {
  elements.historyList.innerHTML = chats
    .map(
      (chat) => `
        <button class="history-item ${chat.id === state.activeChatId ? "active" : ""}" type="button" data-chat-id="${chat.id}">
          <strong>${chat.title}</strong>
          <span>${chat.preview}</span>
          <span>${chat.time}</span>
        </button>
      `
    )
    .join("");

  document.querySelectorAll("[data-chat-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeChatId = button.dataset.chatId;
      renderHistory();
      renderMessages();
    });
  });
}

function renderMessages() {
  const chat = chats.find((item) => item.id === state.activeChatId);
  elements.chatTitle.textContent = chat.title;
  elements.chatMeta.textContent = chat.time;
  elements.messageList.innerHTML = chat.messages
    .map((message) => `<div class="message ${message.role}">${message.text}</div>`)
    .join("");
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderContents() {
  elements.libraryListView.classList.remove("hidden");
  elements.contentDetail.classList.add("hidden");
  elements.contentGrid.innerHTML = contents
    .map(
      (item, index) => `
        <button class="content-card" type="button" data-content-index="${index}">
          <div class="content-thumb" style="background-image: url('${item.image}')"></div>
          <div class="content-body">
            <span>${item.tag} / ${item.date}</span>
            <strong>${item.title}</strong>
            <p>${item.summary}</p>
          </div>
        </button>
      `
    )
    .join("");

  document.querySelectorAll("[data-content-index]").forEach((button) => {
    button.addEventListener("click", () => renderContentDetail(Number(button.dataset.contentIndex)));
  });
}

async function copyText(text, button, successLabel) {
  const originalLabel = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = successLabel;
    button.classList.add("success-action");
  } catch (error) {
    button.textContent = "复制失败";
    button.classList.add("error-action");
  }

  window.setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove("success-action", "error-action");
  }, 1400);
}

function renderContentDetail(index) {
  const item = contents[index];
  const bodyText = item.paragraphs.join("\n\n");
  elements.libraryListView.classList.add("hidden");
  elements.contentDetail.classList.remove("hidden");
  elements.contentDetail.innerHTML = `
    <div class="detail-topbar">
      <button id="backToLibraryButton" class="secondary-action" type="button">返回内容库</button>
      <p class="detail-meta">${item.tag} / ${item.date}</p>
    </div>
    <div class="detail-title-row">
      <h3>${item.title}</h3>
      <button id="copyTitleButton" class="secondary-action" type="button">复制标题</button>
    </div>
    <figure class="detail-hero-figure">
      <img class="detail-image" src="${item.detailImage}" alt="${item.title}" />
      <figcaption>封面图 / 可随正文一起复制图片链接</figcaption>
    </figure>
    <div class="article-preview">
      <div class="article-section-heading">
        <strong>正文</strong>
        <button id="copyBodyButton" class="secondary-action" type="button">复制正文</button>
      </div>
      <div class="article-body">
        ${item.paragraphs
          .map((paragraph, paragraphIndex) => {
            const image = item.inlineImages[paragraphIndex - 1];
            return `
              ${image ? `<img class="article-inline-image" src="${image}" alt="${item.title}配图${paragraphIndex}" />` : ""}
              <p>${paragraph}</p>
            `;
          })
          .join("")}
      </div>
    </div>
  `;

  document.querySelector("#backToLibraryButton").addEventListener("click", () => {
    elements.contentDetail.classList.add("hidden");
    elements.libraryListView.classList.remove("hidden");
  });
  document.querySelector("#copyTitleButton").addEventListener("click", (event) => {
    copyText(item.title, event.currentTarget, "标题已复制");
  });
  document.querySelector("#copyBodyButton").addEventListener("click", (event) => {
    copyText(bodyText, event.currentTarget, "正文已复制");
  });
  elements.contentDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderProfileWechat() {
  if (state.profileWechatStatus === "bound") {
    elements.profileWechatState.innerHTML = `
      <div class="wechat-avatar">微</div>
      <div class="wechat-user">
        <strong>已绑定：AI 员工指挥号</strong>
        <span>微信号：content_helper_88</span>
        <span class="success-text">绑定时间：今天 10:42</span>
      </div>
      <div class="command-list">
        <span>可用微信指令</span>
        <strong>帮我推荐明天公众号选题</strong>
        <strong>生成一篇小红书探店图文</strong>
        <strong>把这段文案改得更有转化感</strong>
      </div>
      <div class="wechat-log">
        最近指令：生成 3 个适合本周发布的私域活动选题
      </div>
      <button id="unbindWechatButton" class="secondary-action" type="button">解除绑定</button>
    `;
    document.querySelector("#unbindWechatButton").addEventListener("click", () => {
      state.profileWechatStatus = "unbound";
      renderProfileWechat();
    });
    return;
  }

  if (state.profileWechatStatus === "qr") {
    elements.profileWechatState.innerHTML = `
      ${renderQrCode()}
      <strong>扫码绑定 AI 员工</strong>
      <span>请在微信中确认授权，绑定后即可发送任务</span>
      <button id="completeWechatButton" class="primary-action" type="button">模拟扫码完成</button>
    `;
    document.querySelector("#completeWechatButton").addEventListener("click", () => {
      state.profileWechatStatus = "bound";
      renderProfileWechat();
    });
    return;
  }

  elements.profileWechatState.innerHTML = `
    <strong>尚未绑定微信</strong>
    <span>绑定后可直接发送这些指令</span>
    <div class="command-list">
      <strong>帮我推荐明天公众号选题</strong>
      <strong>生成一篇小红书探店图文</strong>
      <strong>把这篇文章改成朋友圈口吻</strong>
    </div>
    <button id="bindWechatButton" class="primary-action" type="button">立即绑定</button>
  `;
  document.querySelector("#bindWechatButton").addEventListener("click", () => {
    state.profileWechatStatus = "qr";
    renderProfileWechat();
  });
}

function renderAll() {
  switchSection(state.activeSection);
  renderHistory();
  renderMessages();
  renderContents();
  renderProfileWechat();
}

elements.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
});

elements.authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.authMode === "register" && state.registerWechatStatus !== "bound") {
    elements.authHint.textContent = "请先扫码绑定 AI 员工通道。";
    elements.authHint.className = "form-hint error-text";
    return;
  }

  const phone = elements.phoneInput.value.trim();
  const password = elements.passwordInput.value.trim();

  if (!/^1\d{10}$/.test(phone)) {
    elements.authHint.textContent = "请输入 11 位中国大陆手机号。";
    elements.authHint.className = "form-hint error-text";
    return;
  }

  if (password.length < 6) {
    elements.authHint.textContent = "密码至少需要 6 位。";
    elements.authHint.className = "form-hint error-text";
    return;
  }

  state.password = password;
  enterApp();
});

elements.navItems.forEach((item) => {
  item.addEventListener("click", () => switchSection(item.dataset.section));
});

elements.logoutButton.addEventListener("click", () => {
  elements.appView.classList.add("hidden");
  elements.authView.classList.remove("hidden");
});

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text) {
    return;
  }

  const chat = chats.find((item) => item.id === state.activeChatId);
  chat.messages.push({ role: "user", text });
  chat.messages.push({ role: "assistant", text: `已收到，我会基于「${text}」继续补充图文结构、标题和正文要点。` });
  chat.preview = text;
  chat.time = "刚刚";
  elements.chatInput.value = "";
  renderHistory();
  renderMessages();
});

elements.newChatButton.addEventListener("click", () => {
  const nextId = `chat-${Date.now()}`;
  chats.unshift({
    id: nextId,
    title: "新的对话",
    time: "刚刚",
    preview: "开始一次新的内容创作",
    messages: [{ role: "assistant", text: "你好，请告诉我你想生成什么内容，我可以帮你整理成图文方案。" }]
  });
  state.activeChatId = nextId;
  renderHistory();
  renderMessages();
});

elements.profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const oldPassword = elements.oldPasswordInput.value;
  const newPassword = elements.newPasswordInput.value;

  if (oldPassword !== state.password) {
    elements.profileHint.textContent = "当前密码不正确，请重新输入。";
    elements.profileHint.className = "form-hint error-text";
    return;
  }

  if (newPassword.length < 6) {
    elements.profileHint.textContent = "新密码至少需要 6 位。";
    elements.profileHint.className = "form-hint error-text";
    return;
  }

  state.password = newPassword;
  elements.oldPasswordInput.value = "";
  elements.newPasswordInput.value = "";
  elements.profileHint.textContent = "密码已修改成功。";
  elements.profileHint.className = "form-hint success-text";
});

setAuthMode("login");
