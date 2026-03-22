class OpencodeClaudeAuth < Formula
  desc "OpenCode plugin for Claude Code OAuth authentication"
  homepage "https://github.com/griffinmartin/opencode-claude-auth"
  url "https://registry.npmjs.org/opencode-claude-auth/-/opencode-claude-auth-1.0.0.tgz"
  sha256 "2a54d7a7c2b1691b299a3a023f30d80f499ad4ebe79cd5cfd1bb678f7a89a026"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  def post_install
    # Symlink into global node_modules so OpenCode can import() it
    node_modules = HOMEBREW_PREFIX/"lib/node_modules"
    node_modules.mkpath
    link_target = node_modules/"opencode-claude-auth"
    link_target.unlink if link_target.exist? || link_target.symlink?
    link_target.make_symlink(libexec/"lib/node_modules/opencode-claude-auth")

    # Auto-configure OpenCode plugin
    config_dir = Pathname.new(Dir.home)/".config/opencode"
    config_file = config_dir/"opencode.json"
    config_dir.mkpath

    require "json"
    config = if config_file.exist?
      JSON.parse(config_file.read)
    else
      {}
    end

    plugins = Array(config["plugin"])
    unless plugins.include?("opencode-claude-auth")
      plugins << "opencode-claude-auth"
      config["plugin"] = plugins
      config_file.atomic_write(JSON.pretty_generate(config) + "\n")
    end
  end

  def caveats
    <<~EOS
      The plugin has been added to your OpenCode config at:
        ~/.config/opencode/opencode.json

      To unregister before uninstalling, remove "opencode-claude-auth"
      from the "plugin" array in that file.
    EOS
  end

  test do
    module_path = libexec/"lib/node_modules/opencode-claude-auth/opencode-claude-auth.js"
    output = shell_output("#{Formula["node"].bin}/node -e 'import(\"#{module_path}\").then(m => console.log(typeof m.default))'")
    assert_match "function", output
  end
end
