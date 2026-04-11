@echo off
chcp 65001 >nul
echo ============================================
echo   帝拓音频完整产品图片下载 (Windows)
echo   包含所有子分类
echo ============================================
echo.

set BASE_DIR=ditor-full-images
if not exist %BASE_DIR% mkdir %BASE_DIR%
cd %BASE_DIR%

echo [1/8] 公共广播系统 - 网络广播系统...
if not exist "01-网络广播系统" mkdir "01-网络广播系统"
cd "01-网络广播系统"
curl -s -O "https://ditor.cn/uploads/allimg/20240508/1-24050R22610241.jpg"
echo   网络防爆对讲终端N-TEL30
curl -s -O "https://ditor.cn/uploads/allimg/20240201/1-2402011114191A.jpg"
echo   全国产化网络广播服务器N-C900
curl -s -O "https://ditor.cn/uploads/allimg/20230604/1-23060416131L64.jpg"
echo   IP网络音频采集器 N-CJ4
curl -s -O "https://ditor.cn/uploads/allimg/20220830/1-220S01S621917.jpg"
echo   N-AL32 三十二路网络报警器
curl -s -O "https://ditor.cn/uploads/allimg/20220830/1-220S01QR3c6.jpg"
echo   N-AL16 十六路网络报警器
curl -s -O "https://ditor.cn/uploads/allimg/20220830/1-220S01P629318.jpg"
echo   N-TS01 网络广播卫星校时服务器
cd ..

echo.
echo [2/8] 公共广播系统 - 智能广播设备...
if not exist "02-智能广播设备" mkdir "02-智能广播设备"
cd "02-智能广播设备"
curl -s -O "https://ditor.cn/uploads/allimg/20240520/1-240520104359160.jpg"
echo   四通道定压数字功放
curl -s -O "https://ditor.cn/uploads/allimg/20240520/1-240520102JR36.jpg"
echo   两通道定压数字功放
curl -s -O "https://ditor.cn/uploads/allimg/20240424/1-240424143049434.jpg"
echo   1U数字定压功放
echo   [注意] 大功率定压数字功放 - 无图片
echo   [注意] USB蓝牙四分区音量独调合并式功率放大器 - 无图片
echo   [注意] MP3蓝牙1U数字定压功放 - 无图片
cd ..

echo.
echo [3/8] 公共广播系统 - 天花扬声器...
if not exist "03-天花扬声器" mkdir "03-天花扬声器"
cd "03-天花扬声器"
curl -s -O "https://ditor.cn/uploads/allimg/20230330/1-230330125005552.jpg"
echo   CL-D610 CL-D620悬吊式扬声器
curl -s -O "https://ditor.cn/uploads/allimg/20230330/1-230330124I3O7.jpg"
echo   CL-D511 吊球式扬声器
curl -s -O "https://ditor.cn/uploads/allimg/20230330/1-230330124U1240.jpg"
echo   CL-D510 吊球式扬声器
curl -s -O "https://ditor.cn/uploads/allimg/181031/1-1Q031133A50-L.jpg"
echo   CL-D515T 同轴吊球扬声器
curl -s -O "https://ditor.cn/uploads/allimg/180612/1-1P612094J00-L.jpg"
echo   CL-Q 嵌入式扬声器
curl -s -O "https://ditor.cn/uploads/allimg/180517/1-1P51F934390-L.jpg"
echo   CL-808F 8寸HIFI吸顶扬声器
cd ..

echo.
echo [4/8] 公共广播系统 - 号角扬声器...
if not exist "04-号角扬声器" mkdir "04-号角扬声器"
cd "04-号角扬声器"
curl -s -O "https://ditor.cn/uploads/allimg/190329/1-1Z3291216410-L.jpg"
echo   S-H30 高音号角扬声器
curl -s -O "https://ditor.cn/uploads/allimg/190329/1-1Z329111I30-L.jpg"
echo   S-HT50 高清号角
curl -s -O "https://ditor.cn/uploads/allimg/190329/1-1Z3291116320-L.jpg"
echo   S-HW50 双单元宽域号角
curl -s -O "https://ditor.cn/uploads/allimg/190329/1-1Z3291115110-L.jpg"
echo   S-HW30 宽域号角
curl -s -O "https://ditor.cn/uploads/allimg/190329/1-1Z329110Q20-L.jpg"
echo   S-HL 远程大型号角系列
cd ..

echo.
echo [5/8] 专业音响系统 - 线阵扬声器...
if not exist "05-线阵扬声器" mkdir "05-线阵扬声器"
cd "05-线阵扬声器"
curl -s -O "https://ditor.cn/uploads/allimg/20231118/1-23111Q50923403.jpg"
echo   双12寸线阵音箱低频扬声器TWL-328
curl -s -O "https://ditor.cn/uploads/allimg/20231118/1-23111Q50100304.jpg"
echo   双12寸线阵音箱 TWL-312
curl -s -O "https://ditor.cn/uploads/allimg/201012/1-2010121T6010-L.jpg"
echo   KW点声源线阵系统
curl -s -O "https://ditor.cn/uploads/allimg/190714/1-1ZG40111440-L.jpg"
echo   TWL-110 10寸多功能线阵音箱
curl -s -O "https://ditor.cn/uploads/allimg/190714/1-1ZG40101270-L.jpg"
echo   TWL-108 8寸多功能线阵音箱
curl -s -O "https://ditor.cn/uploads/allimg/190525/1-1Z5251143240-L.jpg"
echo   TWL12 线阵系列
cd ..

echo.
echo [6/8] 专业音响系统 - 专业音箱...
if not exist "06-专业音箱" mkdir "06-专业音箱"
cd "06-专业音箱"
curl -s -O "https://ditor.cn/uploads/allimg/20240508/1-24050R20SEQ.jpg"
echo   HLJ全天候紧凑型同轴音箱
curl -s -O "https://ditor.cn/uploads/allimg/20230322/1-2303221T104M5.jpg"
echo   TL281 双8寸专业音箱
curl -s -O "https://ditor.cn/uploads/allimg/20230330/1-230330125353c3.jpg"
echo   PL系列防水多功能专业音箱
cd ..

echo.
echo [7/8] 专业音响系统 - 功率放大器...
if not exist "07-功率放大器" mkdir "07-功率放大器"
cd "07-功率放大器"
curl -s -O "https://ditor.cn/uploads/allimg/200709/1-200F91301190-L.jpg"
echo   DP4.06 DP4.08四通道数字功放
curl -s -O "https://ditor.cn/uploads/allimg/190320/1-1Z3202211490-L.jpg"
echo   DP4数字功放系列
curl -s -O "https://ditor.cn/uploads/190320/1-1Z320192Z3W1.jpg"
echo   QM2 大功率专业功放系列
curl -s -O "https://ditor.cn/uploads/190828/1-1ZRR13501a1.jpg"
echo   QM4 4通道专业功率放大器
curl -s -O "https://ditor.cn/uploads/190827/1-1ZRH35A9E6.jpg"
echo   QM2专业功率放大器系列
curl -s -O "https://ditor.cn/uploads/allimg/181025/1-1Q0251021570-L.jpg"
echo   QT系列专业功放
cd ..

echo.
echo [8/8] 会议系统 - 会议扬声器...
if not exist "08-会议扬声器" mkdir "08-会议扬声器"
cd "08-会议扬声器"
curl -s -O "https://ditor.cn/uploads/allimg/20230418/1-23041R00243440.jpg"
echo   多功能阵列式线柱扬声器TL-454H
curl -s -O "https://ditor.cn/uploads/allimg/20220928/1-22092Q605191M.jpg"
echo   会议音箱 M161
curl -s -O "https://ditor.cn/uploads/allimg/20220928/1-22092Q60634K6.jpg"
echo   会议音箱 M261
curl -s -O "https://ditor.cn/uploads/allimg/210813/1-210Q31QJ80-L.jpg"
echo   多功能音箱 M243
curl -s -O "https://ditor.cn/uploads/allimg/210813/1-210Q31Q5290-L.jpg"
echo   多功能音箱 M143
curl -s -O "https://ditor.cn/uploads/allimg/201207/1-20120G60Q90-L.jpg"
echo   M508 双高音高保真吸顶扬声器
cd ..

echo.
echo ============================================
echo   下载完成！
echo ============================================
echo.
echo 文件保存在: %cd%
echo.
echo 目录结构:
dir /b /ad
echo.
echo 提示: 部分产品没有抓取到图片链接，
echo       显示为"无图片"的需要手动访问网页获取
echo.
pause
