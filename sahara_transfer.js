import { ethers } from 'ethers';
import fs from 'fs';

// 创建 ethers.js 提供者
const provider = new ethers.JsonRpcProvider('https://testnet.saharalabs.ai');

// 失败交易记录文件
const FAILED_TX_LOG = 'single_failed_transactions.txt';

// 解析钱包范围参数
function parseWalletRange(rangeStr) {
    if (!rangeStr) return null;

    const wallets = new Set();
    const ranges = rangeStr.split(',');

    for (const range of ranges) {
        if (range.includes('-')) {
            const [start, end] = range.split('-').map(num => parseInt(num.trim()));
            for (let i = start; i <= end; i++) {
                wallets.add(i.toString());
            }
        } else {
            wallets.add(range.trim());
        }
    }

    return wallets;
}

// 获取命令行参数
const walletRange = process.argv[2]; // 例如: "1-5" 或 "1,3,5" 或 "1-3,5,7-9"
const selectedWallets = parseWalletRange(walletRange);

// 检查文件是否存在
if (!fs.existsSync('transfer_pairs.txt')) {
    console.error('错误: transfer_pairs.txt 文件不存在!');
    process.exit(1);
}

// 读取转账对
let transferPairs;
try {
    const fileContent = fs.readFileSync('transfer_pairs.txt', 'utf-8');
    console.log('文件内容:', fileContent); // 调试用

    transferPairs = fileContent
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
            const [walletId, privateKey, toAddress] = line.split(',').map(item => item.trim());
            if (!privateKey || !toAddress) {
                throw new Error(`无效的行格式: ${line}`);
            }
            return { walletId, privateKey, toAddress };
        })
        .filter(pair => !selectedWallets || selectedWallets.has(pair.walletId));

    console.log(`已加载 ${transferPairs.length} 个转账对`);
} catch (error) {
    console.error('读取转账对时出错:', error);
    process.exit(1);
}

// 打乱转账对顺序
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 生成随机金额 (0.000000001~0.000000100 ETH)
function getRandomAmount() {
    const min = 10;   // 1 Gwei
    const max = 10000; // 1000 Gwei
    const random = Math.floor(Math.random() * (max - min + 1)) + min;
    return ethers.parseUnits(random.toString(), 'gwei');
}

// 生成随机时间间隔 (30-180秒)
function getRandomInterval() {
    return Math.floor(Math.random() * (360 - 60 + 1) + 60) * 1000;
}

let nonceTracker = {};  // 记录每个钱包的 nonce

async function getNonce(wallet) {
    if (!(wallet.address in nonceTracker)) {
        nonceTracker[wallet.address] = await provider.getTransactionCount(wallet.address, 'latest');
    }
    return nonceTracker[wallet.address]++;
}

// 记录失败的交易
function logFailedTransaction(walletId, fromAddress, toAddress, error) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp},${walletId},${fromAddress},${toAddress},${error}\n`;
    
    try {
        fs.appendFileSync(FAILED_TX_LOG, logEntry);
        console.log(`已记录失败交易到 ${FAILED_TX_LOG}`);
    } catch (err) {
        console.error(`无法记录失败交易:`, err);
    }
}

// 发送交易
async function sendTransaction(walletId, fromPrivateKey, toAddress, amount) {
    let attempts = 0;
    const maxAttempts = 5;
    let wallet;
    
    try {
        wallet = new ethers.Wallet(fromPrivateKey, provider);
    } catch (error) {
        console.error(`创建钱包对象失败:`, error);
        logFailedTransaction(walletId, "无法获取地址", toAddress, "创建钱包对象失败");
        return false;
    }
    
    while (attempts < maxAttempts) {
        attempts++;
        try {
            console.log(`尝试第 ${attempts}/${maxAttempts} 次发送交易...`);
            console.log(`钱包编号: ${walletId}`);
            console.log(`发送地址: ${wallet.address}`);

            const nonce = await getNonce(wallet);
            console.log(`Nonce: ${nonce}`);

            const gasPrice = await provider.getFeeData();
            console.log(`当前 gas 价格: ${ethers.formatUnits(gasPrice.gasPrice, 'gwei')} Gwei`);

            const tx = {
                to: toAddress,
                value: amount,
                gasLimit: 21000,
                gasPrice: ethers.parseUnits("2.5", "gwei"),
                nonce: nonce
            };

            console.log('发送交易...');
            const txResponse = await wallet.sendTransaction(tx); // ✅ 这里必须用 wallet.sendTransaction
            console.log(`交易已广播，等待确认: ${txResponse.hash}`);

            const receipt = await txResponse.wait();
            console.log(`交易成功!`);
            console.log(`钱包编号: ${walletId}`);
            console.log(`发送地址: ${wallet.address}`);
            console.log(`接收地址: ${toAddress}`);
            console.log(`金额: ${ethers.formatEther(amount)} ETH`);
            console.log(`交易哈希: ${receipt.hash}`);
            return true;
        } catch (error) {
            console.error(`第 ${attempts} 次交易失败:`, error);
            
            if (attempts >= maxAttempts) {
                console.error(`已达到最大重试次数 (${maxAttempts})，放弃此交易`);
                logFailedTransaction(walletId, wallet.address, toAddress, `尝试 ${maxAttempts} 次后失败`);
                return false;
            }
            
            // 等待几秒后重试
            const retryDelay = 3000; // 3秒
            console.log(`等待 ${retryDelay/1000} 秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    
    return false;
}

// 主函数
async function batchTransfer() {
    console.log('开始批量转账...');

    const shuffledPairs = shuffleArray([...transferPairs]);
    console.log(`总共需要处理: ${shuffledPairs.length} 笔交易`);

    const usedAddresses = new Set();
    const successfulWallets = new Set();
    const failedWallets = new Set();

    for (const [index, pair] of shuffledPairs.entries()) {
        console.log(`\n处理第 ${index + 1}/${shuffledPairs.length} 笔交易`);

        if (usedAddresses.has(pair.privateKey)) {
            console.log(`钱包 ${pair.walletId} 已经完成转账，跳过`);
            continue;
        }

        if (!ethers.isAddress(pair.toAddress)) {
            console.log(`无效的接收地址: ${pair.toAddress}`);
            logFailedTransaction(pair.walletId, "未知", pair.toAddress, "无效的接收地址");
            failedWallets.add(pair.walletId);
            continue;
        }

        try {
            const wallet = new ethers.Wallet(pair.privateKey, provider);
            const balance = await provider.getBalance(wallet.address);
            console.log(`钱包 ${pair.walletId} 余额: ${ethers.formatEther(balance)} ETH`);

            if (balance <= ethers.parseUnits("0.0000001", 'ether')) {
                console.log(`钱包 ${pair.walletId} 余额不足`);
                logFailedTransaction(pair.walletId, wallet.address, pair.toAddress, "余额不足");
                failedWallets.add(pair.walletId);
                continue;
            }

            const amount = getRandomAmount();
            console.log(`转账金额: ${ethers.formatEther(amount)} ETH`);

            const success = await sendTransaction(pair.walletId, pair.privateKey, pair.toAddress, amount);
            
            if (success) {
                successfulWallets.add(pair.walletId);
            } else {
                failedWallets.add(pair.walletId);
            }

            usedAddresses.add(pair.privateKey);

            const interval = getRandomInterval();
            console.log(`等待 ${interval / 1000} 秒后进行下一笔交易...`);
            await new Promise(resolve => setTimeout(resolve, interval));
        } catch (error) {
            console.error(`处理第 ${index + 1} 笔交易时出错:`, error);
            logFailedTransaction(pair.walletId, "处理错误", pair.toAddress, error.message);
            failedWallets.add(pair.walletId);
        }
    }

    // 输出批处理结果
    console.log('\n批量转账完成!');
    console.log(`成功: ${successfulWallets.size} 个钱包`);
    console.log(`失败: ${failedWallets.size} 个钱包`);
    
    if (failedWallets.size > 0) {
        const failedList = Array.from(failedWallets).sort().join(',');
        console.log(`失败钱包列表: ${failedList}`);
        console.log(`可用于下次执行的参数格式: "${failedList}"`);
        
        // 将失败列表写入文件
        try {
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            const filename = `failed_wallets_${timestamp}.txt`;
            fs.writeFileSync(filename, failedList);
            console.log(`已将失败钱包ID保存到文件: ${filename}`);
        } catch (err) {
            console.error('保存失败钱包列表时出错:', err);
        }
    }
}

// 运行脚本
console.log('脚本启动');
console.log('Ethers.js 版本:', ethers.version);
console.log('连接到:', provider._getConnection().url);

batchTransfer().catch(error => {
    console.error('致命错误:', error);
    process.exit(1);
});