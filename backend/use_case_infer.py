import re
from typing import Dict, Any, Optional

# 常见核心物料精准用途映射表
EXACT_USE_CASE_MAP = {
    # 主控、模组与开发板
    'C55652778': 'ARM Cortex-M0 32位主控原型开发，板载SWD烧录与全引出GPIO',
    'C2934560': '2.4GHz Wi-Fi + BLE5 核心物联网无线主控节点',
    'C2913202': 'ESP32-S3 双核高算力主控，带16MB Flash+8MB PSRAM，支持离线语音与相机',
    'C22400303': '490MHz LPWAN/LoRa 远距离穿墙无线数传模组',
    'C50331915': '1Gb (128MB) 工业级SLC贴片SD NAND闪存，高速存储日志与固件',
    
    # 传感器与采集
    'C3012622': '高精度I2C数字温湿度测量，环境监控与智能家居联动',
    'C491450': '数字大气气压与海拔高度监测芯片，高精度微气压感知',
    'C42456414': '16位超高精度单总线测温芯片 (0.004℃分辨率)，多探头并联',
    'C22400320': '全极微功耗霍尔磁感应开关，门窗防盗检测与非接触位置感应',
    'C19267425': '高信噪比MEMS贴片数字硅麦，语音采集与声控触发',
    
    # 电源管理、稳压与隔离
    'C3031185': '9~36V宽压输入转5V 6W工业级定电压隔离电源模块',
    'C7465178': 'B0505S 1W 5V转5V定电压隔离DC-DC模块，传感器/RS485电气隔离',
    'C54560864': 'HR1117-3.3 1A低压差稳压LDO，为MCU与无线模组提供3.3V清洁供电',
    'C112446': '78L05 35V耐压150mA线性稳压管，24V/12V宽压降压至5V供电',
    'C2895856': '40V高耐压100mA超低静态功耗LDO稳压器',
    'C3190136': '24V 2A 1.5MHz高效率同步降压DC-DC开关电源芯片',
    
    # 大功率驱动与控制
    'C42370420': 'IRLZ34N 55V 30A大功率N沟道功率MOS管，电机PWM与大功率灯带驱动',
    'C148357': 'WST4041 40V 6A P沟道贴片MOS管，高边电源防反接与软开关控制',
    'C480660': 'EG2132 1.5A高低边半桥驱动芯片，单片机驱动MOS管/半桥电机',
    'C181158': 'S8050 NPN 25V 500mA通用驱动三极管，驱动蜂鸣器、小继电器与指示灯',
    'C414015': '2N7002K 60V 300mA小信号MOS管，I2C/UART双向电平转换与微弱信号开关',
    
    # 安全保护与防浪涌
    'C2982262': '0805 24V 0.5A PPTC自恢复保险丝，USB/MCU供电过流防烧保护',
    'C70065': '1206 60V 0.1A PPTC自恢复保险丝，总线信号输入过流自恢复保护',
    'C960026': '1812 30V 2A大电流自恢复保险丝，电源主输入端过载防烧保护',
    'C5210978': '0402 40V超低电容双向TVS/ESD静电保护管，高频通信引脚防击穿',
    'C363066': '10D471K 775V压敏电阻，交流/直流电源输入防雷抗瞬态浪涌保护',
    'C402302': 'SS14 40V 1A贴片肖特基二极管，电源防反接保护与整流',
    'C8678': 'SS34 40V 3A大电流肖特基二极管，DC-DC续流与主电源防反接',
    'C541665': 'MB10F 1000V 0.8A贴片整流桥堆，交流转直流全波整流',
    'C20612591': 'PC817 SOP-4晶体管输出光电耦合器，强弱电电气安全隔离',
    'C22451245': '7mm卡扣式铁氧体抗干扰磁环，套在传感器线缆上滤除高频EMI毛刺',
    'C47345482': '7mm卡扣式抗干扰屏蔽磁环，电源线与USB通信防杂波滤波',
    
    # 储能与滤波
    'C7471020': '3V 20F超大容量掉电数据保存法拉超级电容，秒级掉电维持保护',
    'C46527418': '470µF 16V贴片铝电解电容，直流电源低频大容量滤波稳压',
    'C19103847': '0805 10µF 25V贴片陶瓷电容，芯片主电源去耦与低通滤波',
    'C105759': 'X2 100nF 275VAC安规抗干扰薄膜电容，电源入口差模滤波抑制杂音',
    'C5349705': '4.7µH 6.5A 0630贴片一体成型合金电感，开关电源大电流储能滤波',
    'C54431701': '4.7µH 6.5A 一体成型功率电感，DC-DC高效率输出滤波',
    
    # 逻辑扩展与时钟
    'C20612517': '74HC595 8位串入并出移位寄存器，单片机3线扩展8路数字输出',
    'C510548': '100M单口贴片网络隔离变压器，以太网PHY芯片防雷隔离与滤波',
    'C19076879': '32.768kHz贴片无源晶振，为单片机RTC实时时钟提供微功耗走时基准',
    'C49158215': '32.768kHz 20ppm高精时钟晶振，系统低功耗休眠定时器',
    
    # 采样分流电阻
    'C2903468': '2512 3W 10mΩ ±1%大功率合金采样分流电阻，配INA226测量安培级电流',
    'C5224158': '2512 6W 1mΩ车规级电子束焊高精采样分流电阻，大功率极低损耗电流采样',
    
    # 按键开关与拨码
    'C393938': '6x6x5mm直插轻触按键开关，面包板搭线、硬件复位与功能触发',
    'C720477': '3.9x3x2mm立贴微动轻触按键，板载微型复位键与侧按键',
    'C5289932': '1.27mm间距3位平拨贴片拨码开关，单片机硬件地址与工作模式设定',
    'C42435428': '轻触按键专用彩色按键帽盖，方便面板按压与色彩区分',
    
    # 排针排母与接插件
    'C54950610': '1x40P 2.54mm单排直插排针，开发板引脚全引出、模块焊接连接',
    'C27985187': '1x2P 2.54mm直插短路排针，板载硬件跳线与配置短接帽',
    'C2691448': '1x4P 2.54mm直排针，I2C/串口传感器标准4Pin扩展引脚',
    'C49006158': '1x4P 2.54mm直插排母插座，传感器模块直插母座、防接错排座',
    'C718241': '1x4P 2.54mm单排母座，扩展板对接母口与传感器插接',
    'C239364': 'XH2.54 1x4P防呆直针座，机箱引线与外部传感器防插反接口',
    'C2936229': 'PH2.0 4P立贴线对板插座，超薄引线连接座',
    'C51912233': '24Pin Type-C卧贴四脚插板母座，USB-C接口板级供电与固件烧录',
    'C7527710': '24Pin Type-C卧贴公头插头，自制Type-C转接头与测试治具',
    'C42931365': 'M12 12芯工业防水航空插头，野外/工业传感器多芯线缆防水连接',
    'C1509208': '镀金SMA射频天线母座，外接490M/2.4G胶棒天线与吸盘天线',
    'C20617215': '直插板端SMA天线母座，射频模组天线外引标准接口',
    'C5157269': 'Pogo Pin镀金弹簧顶针探针，测试点烧录治具与磁吸充电触点',
    'C404969': 'Micro-USB 5Pin卧贴母座，板载5V供电与通信调试接口',
    
    # 工具与显示
    'C5248080': '0.96寸12864 OLED高对比度单色显示屏，实时显示传感器读数与系统状态',
    'C22461793': '5050 WS2812B单总线内置IC幻彩RGB灯珠，单片机单引脚控制级联彩灯',
    'C2687681': '12mm 5V电磁式有源/无源发声蜂鸣器，系统报警与按键蜂鸣提示',
    'C530531': '23mm 8Ω 1W微型插针扬声器小喇叭，单片机语音播报与提示音播放',
    'C22467691': '2.4GHz 5x2mm SMD陶瓷贴片天线，板载超小体积Wi-Fi/蓝牙天线',
    'C91372': '维修佬ESD-15防静电尖头弯镊，精密0402/0603贴片元器件焊接与微小芯片夹取',
    'C2936375': '得力DL0306A防滑包胶斜嘴剪钳，电子剪线、元件引脚平整切剪与水口修整',
    'C55125813': '6800µF 80V巨型牛角铝电解大储能电容，大功率整流滤波与瞬态大电流放电',
}

def infer_material_use_case(code: str, category: str, brand: str, model: str, name_desc: str = "") -> str:
    """
    智能推导元器件真实硬件用途：
    1. 优先查阅精准物料场景库；
    2. 基于型号、品类、物理参数进行工程级语义识别。
    """
    code = (code or "").strip().upper()
    if code in EXACT_USE_CASE_MAP:
        return EXACT_USE_CASE_MAP[code]
        
    full_text = f"{category} {brand} {model} {name_desc}".upper()
    
    # 阻值推导
    if '电阻' in category or 'RES' in full_text:
        if '0.001' in full_text or '1MR' in full_text or '10MR' in full_text or '毫欧' in full_text or '采样' in full_text:
            return '大功率低阻毫欧采样分流电阻，配INA226/电流表检测回路电流'
        elif 'NTC' in full_text or '热敏' in full_text:
            return '负温度系数NTC热敏电阻，主板过温监测与充放电温度保护'
        elif '压敏' in full_text or '775V' in full_text or '471K' in full_text:
            return '防雷防过压防浪涌压敏电阻，抑制输入端瞬态浪涌毛刺'
        elif '10K' in full_text or '0103' in full_text or '103' in full_text:
            return 'I2C/单总线数据线弱上拉电阻、MCU复位引脚固定逻辑电平'
        elif '4.7K' in full_text or '472' in full_text:
            return 'I2C标准时钟/数据线上拉电阻，保证高低电平边沿陡峭'
        elif '1K' in full_text or '102' in full_text:
            return 'LED指示灯限流分压电阻、三极管基极基极驱动限流'
        elif '100R' in full_text or '100Ω' in full_text or '22R' in full_text:
            return 'USB数据线D+/D-阻抗匹配电阻、高频信号阻尼防反射'
        elif '0R' in full_text or '0欧' in full_text:
            return '0欧姆跨接跳线电阻、电路模块调试断点与单点共地隔离'
        else:
            return '电路分压限流、偏置电压设定与基础信号衰减匹配'

    # 电容推导
    if '电容' in category or 'CAP' in full_text:
        if '法拉' in full_text or '超级电容' in full_text or '20F' in full_text:
            return '超大容量掉电数据备份电容，为MCU提供秒级断电应急供电'
        elif '铝电解' in full_text or '电解' in full_text:
            return '直流供电低频大容量储能滤波，平滑纹波并抑制瞬间大负载压降'
        elif 'X2' in full_text or '安规' in full_text or '薄膜' in full_text:
            return 'AC/DC输入端X2级抗干扰安规电容，滤除电网差模电磁杂波'
        elif '100NF' in full_text or '0.1UF' in full_text or '104' in full_text:
            return '芯片VCC引脚高频去耦退耦电容，滤除电源高频毛刺防芯片死机'
        elif '10UF' in full_text or '22UF' in full_text or '4.7UF' in full_text:
            return 'LDO/开关稳压芯片输入输出端滤波退耦，保障电源环路稳定'
        elif 'PF' in full_text or '22PF' in full_text or '15PF' in full_text:
            return '晶体振荡器负载匹配电容、射频天线高频微调滤波'
        else:
            return '电路高低频退耦滤波、旁路电容与直流电源平滑'

    # 电感推导
    if '电感' in category or 'IND' in full_text:
        return 'DC-DC开关稳压大电流储能电感、LC滤波防纹波杂音'

    # 二极管/整流
    if '二极管' in category or 'DIODE' in full_text or '整流' in full_text:
        if '肖特基' in full_text or 'SS' in full_text:
            return '低压降快速恢复肖特基二极管，主供电防反接与开关电源续流'
        elif 'TVS' in full_text or 'ESD' in full_text or '静电' in full_text:
            return '防静电TVS保护管，保护通信接口免受人体静电浪涌击穿'
        elif '桥' in full_text:
            return '全波整流桥堆，交流电或交直流无极性输入整流'
        else:
            return '单向导电整流、电路防反冲保护与反向电压钳位'

    # 三极管/MOS管
    if 'MOS' in full_text or '场效应' in category or '三极管' in category:
        if 'P沟道' in full_text or 'P-CHANNEL' in full_text:
            return 'P沟道功率MOS管，高边电源自动切换控制与低损耗防反接'
        elif 'TO-220' in full_text or '30A' in full_text:
            return '大电流大功率NMOS管，PWM驱动直流电机、大功率灯带与继电器'
        else:
            return '小信号开关驱动、单片机弱电驱动弱电负载与电平转换'

    # 接插件/排针排母
    if '排针' in category or '排母' in category or '连接器' in category or '插头' in category or '端子' in category:
        if 'TYPE-C' in full_text:
            return '板载Type-C接口，支持5V快速供电与USB通信烧录'
        elif 'RJ45' in full_text:
            return '百兆以太网有线网口母座，有线网络稳定通信'
        elif 'SMA' in full_text:
            return '标准射频天线接口，外接2.4G/490MHz高增益胶棒天线'
        elif 'XH2.54' in full_text or 'PH2.0' in full_text:
            return '防呆带锁扣线对板插座，外接传感器引线与锂电池组'
        else:
            return 'PCB引脚全引出、模块间对插连接与面包板跳线搭试'

    # 开关按键
    if '开关' in category or '按键' in category or 'BUTTON' in full_text or 'SWITCH' in full_text:
        if '拨码' in full_text:
            return '多位硬件地址配置拨码开关、模式设定与协议切换'
        else:
            return '单片机复位按键、用户功能输入与人机交互触发'

    # 晶振
    if '晶振' in category or 'OSC' in full_text or 'CRYSTAL' in full_text:
        if '32.768' in full_text:
            return 'RTC实时时钟32.768kHz低功耗走时晶振，断电时钟维持'
        else:
            return '单片机高速外部时钟源基准，提供精确指令运行频率'

    # 芯片常规
    if '芯片' in category or 'IC' in full_text:
        return '核心电路信号处理、专用逻辑驱动与控制'

    # 工具五金
    if '镊子' in full_text or '钳' in full_text or '螺柱' in full_text or '五金' in category:
        return '电路板组装焊接辅助、贴片元器件精密夹持与结构固定支撑'

    return f'原厂正品标准备件，用于相关硬件电路搭建与功能实现'
