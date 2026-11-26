(function () {
  const button = document.getElementById('btnInstalar');
  const modal = document.getElementById('modalInstalacao');
  const instructions = document.getElementById('instrucoesInstalacao');
  const standalone = window.matchMedia('(display-mode: standalone)');
  let installPrompt = null;
  let registrationFailed = false;

  function updateButton() {
    button.hidden = standalone.matches || navigator.standalone === true;
  }

  function showInstructions(message) {
    instructions.textContent = message;
    modal.classList.add('open');
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    button.hidden = true;
    modal.classList.remove('open');
  });

  if (standalone.addEventListener) standalone.addEventListener('change', updateButton);
  else if (standalone.addListener) standalone.addListener(updateButton);

  button.addEventListener('click', async () => {
    if (!window.isSecureContext) {
      return showInstructions('Para instalar, abra o endereço HTTPS do garçom no navegador do celular.');
    }
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try {
        await prompt.prompt();
      } catch (error) {
        console.error('Não foi possível abrir a instalação:', error);
        showInstructions('Não foi possível abrir a instalação. Use o menu do navegador e escolha Instalar aplicativo ou Adicionar à tela inicial.');
      }
      return;
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      showInstructions('No Safari, toque em Compartilhar e escolha Adicionar à Tela de Início. Depois, toque em Adicionar.');
    } else if (registrationFailed) {
      showInstructions('Não foi possível preparar a instalação. Verifique a conexão e recarregue a página antes de tentar novamente.');
    } else {
      showInstructions('No navegador, abra o menu e escolha Instalar aplicativo ou Adicionar à tela inicial.');
    }
  });

  document.getElementById('fecharInstalacao').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.classList.remove('open');
  });

  updateButton();
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./garcom-sw.js', { scope: './gar%C3%A7on.html' })
      .catch(error => {
        registrationFailed = true;
        console.error('Não foi possível preparar a instalação:', error);
      });
  }
})();
