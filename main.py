import sys
import subprocess

def main():
    print("=========================================")
    print("   ComfyUI Listener - Python Script Setup ")
    print("=========================================")
    print(f"Python Version : {sys.version}")
    print(f"Executable Path: {sys.executable}")
    
    # Check if local Git is accessible
    try:
        git_version = subprocess.check_output(["git", "--version"], stderr=subprocess.STDOUT, text=True)
        print(f"Git Version    : {git_version.strip()}")
    except Exception as e:
        print(f"Git Check      : Failed to locate or run Git. Error: {e}")
        
    print("=========================================")
    print("Virtual environment is running successfully!")
    print("=========================================")

if __name__ == "__main__":
    main()
